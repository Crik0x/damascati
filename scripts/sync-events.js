/**
 * sync-events.js
 * Versione: v4 (adattato al nuovo schema GENESI_DAMASCATI_v2)
 * Creato:   2026-07-01 15:20 (Europe/Rome)
 * Sostituisce: sync-events.js v3
 *
 * COSA CAMBIA rispetto alla v3 (SOLO letture dal DB, output JSON invariato):
 *   · tabella 'eventi'  → 'events'
 *   · formats: filtro 'attivo' → 'active'
 *   · evt.citta         → evt.city
 *   · evt.prezzo_*      → evt.price_*
 *   · formats: nome, descrizione_breve, descrizione_completa, immagine_default,
 *     categoria, visibilita_default, durata_ore, prezzo_(tier)_default, attivo
 *     diventano: name, short_description, full_description, default_image,
 *     category, default_visibility, duration_hours, default_price_(tier), active
 *
 * Il JSON prodotto (damascati_events.json / events_archive.json) mantiene le
 * STESSE chiavi di prima (citta, pricing_event, ecc.): il sito Tilda non va toccato.
 *
 * Legge eventi, formats e config da Supabase (service_role) e scrive:
 *   - damascati_events.json  (eventi futuri pubblicati)
 *   - events_archive.json    (eventi passati)
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const fs = require('fs');

async function query(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error on ${table}: ${err}`);
  }
  return res.json();
}

function isExpired(evento) {
  const end = new Date(evento.date_end || evento.date_start);
  end.setHours(end.getHours() + 2);
  return end < new Date();
}

// Calcola prezzo tier applicando lo sconto sul prezzo base.
// Se il prezzo manuale è impostato → usa quello.
// Se non è impostato → calcola da price_osservatore × (1 - sconto%).
function calcolaPrezzo(prezzoManuale, prezzoBase, scontoPercent) {
  if (prezzoManuale !== null && prezzoManuale !== undefined) return prezzoManuale;
  if (!prezzoBase) return null;
  return Math.round(prezzoBase * (1 - scontoPercent / 100));
}

function buildPricingEvent(evt, config) {
  if (evt.pricing_free) return { free_with_booking: true };
  // Su invito: il prezzo viene comunicato con l'invito, non nel JSON pubblico
  if (evt.visibility === 'su_invito') return { su_invito: true };

  const base = evt.price_osservatore ?? null;
  const sc   = parseFloat(config.sconto_custode   || '10');
  const sd   = parseFloat(config.sconto_damascato || '25');

  return {
    osservatore: base,
    custode:     calcolaPrezzo(evt.price_custode,   base, sc),
    damascato:   calcolaPrezzo(evt.price_damascato, base, sd)
  };
}

function buildPricingFormat(fmt, config) {
  if (fmt.default_visibility === 'su_invito') return { su_invito: true };
  const base = fmt.default_price_osservatore ?? null;
  if (!base && !fmt.default_price_custode) {
    return { free_with_booking: true };
  }
  const sc = parseFloat(config.sconto_custode   || '10');
  const sd = parseFloat(config.sconto_damascato || '25');
  return {
    osservatore: base,
    custode:     calcolaPrezzo(fmt.default_price_custode,   base, sc),
    damascato:   calcolaPrezzo(fmt.default_price_damascato, base, sd)
  };
}

function eventToJson(evt, fmt, config) {
  return {
    id:          evt.id,
    format_id:   evt.format_id,
    title:       evt.title,
    citta:       evt.city || '',                 // chiave output invariata: legge da evt.city
    date_start:  evt.date_start,
    date_end:    evt.date_end,
    publish_at:  evt.publish_at,
    visibility:  evt.visibility  || 'public',
    status:      evt.status      || 'available',
    published:   evt.published,
    featured:    evt.featured    || false,
    location: {
      name:     evt.location_name    || '',
      address:  evt.location_address || '',
      maps_url: evt.location_maps_url || ''
    },
    capacity: {
      total:       evt.capacity_total       ?? null,
      available:   evt.capacity_available   ?? null,
      osservatore: evt.capacity_osservatore ?? null,
      custode:     evt.capacity_custode     ?? null,
      damascato:   evt.capacity_damascato   ?? null
    },
    pricing_event:        buildPricingEvent(evt, config),
    description_override: evt.description_override || '',
    media: {
      image_card: evt.image_card || (fmt ? fmt.default_image : '') || ''
    },
    registration: {
      url: evt.registration_url || ''
    },
    google_calendar_id: evt.google_calendar_id || ''
  };
}

function formatToJson(fmt, config) {
  return {
    format_id:         fmt.id,
    base_title:        fmt.name,
    description_short: fmt.short_description  || '',
    description_long:  fmt.full_description   || '',
    image_url:         fmt.default_image      || '',
    category:          fmt.category ? [fmt.category] : [],
    pricing:           buildPricingFormat(fmt, config),
    price_variable:    false,
    duration_hours:    fmt.duration_hours || null,
    visibility:        fmt.default_visibility || 'public'
  };
}

async function main() {
  console.log('🔄 Avvio sync Supabase → JSON...');

  // 1. Carica dati in parallelo (incluso config)
  const [eventiRaw, formatsRaw, configRaw] = await Promise.all([
    query('events',  '?or=(published.eq.true,published.is.null)&order=date_start.asc'),
    query('formats', '?active=eq.true&order=id.asc'),
    query('config',  '?select=chiave,valore')
  ]);

  // Converti config in oggetto chiave→valore
  const config = {};
  configRaw.forEach(r => { config[r.chiave] = r.valore; });

  const sc = parseFloat(config.sconto_custode   || '10');
  const sd = parseFloat(config.sconto_damascato || '25');

  console.log(`📅 Eventi trovati: ${eventiRaw.length}`);
  console.log(`📋 Formats trovati: ${formatsRaw.length}`);
  console.log(`⚙️  Config: sconto_custode=${sc}% | sconto_damascato=${sd}%`);

  const formatsMap = {};
  formatsRaw.forEach(f => formatsMap[f.id] = f);

  // 2. Se formats è vuoto → genera sintetici dagli eventi (nomi NUOVO schema)
  if (formatsRaw.length === 0) {
    console.log('⚠️  Tabella formats vuota — genero formats sintetici dagli eventi');
    const ids = [...new Set(eventiRaw.map(e => e.format_id).filter(Boolean))];
    ids.forEach(fid => {
      const ref = eventiRaw.find(e => e.format_id === fid);
      const synthetic = {
        id: fid,
        name: ref ? (ref.title || fid) : fid,
        short_description: ref ? (ref.description_override || '') : '',
        full_description: '',
        default_image: ref ? (ref.image_card || '') : '',
        category: 'socialita',
        default_visibility: ref ? (ref.visibility || 'public') : 'public',
        default_price_osservatore: ref ? ref.price_osservatore : null,
        default_price_custode: null,
        default_price_damascato: null,
        default_capacity: ref ? ref.capacity_total : null,
        duration_hours: 2.5,
        active: true
      };
      formatsRaw.push(synthetic);
      formatsMap[fid] = synthetic;
    });
    console.log(`✅ Generati ${formatsRaw.length} formats sintetici`);
  }

  // 3. Separa upcoming da archiviati
  const now = new Date();
  const upcoming = [];
  const archived = [];

  for (const evt of eventiRaw) {
    if (evt.publish_at && new Date(evt.publish_at) > now) {
      console.log(`⏳ ${evt.id} non ancora pubblicabile (publish_at: ${evt.publish_at})`);
      continue;
    }
    const fmt = formatsMap[evt.format_id] || null;
    const evtJson = eventToJson(evt, fmt, config);
    if (isExpired(evt)) {
      archived.push(evtJson);
    } else {
      upcoming.push(evtJson);
    }
  }

  console.log(`✅ Upcoming: ${upcoming.length} | 📦 Archived: ${archived.length}`);

  // 4. Merge archivio esistente
  let existingArchive = { archive: [] };
  try {
    if (fs.existsSync('events_archive.json')) {
      existingArchive = JSON.parse(fs.readFileSync('events_archive.json', 'utf8'));
    }
  } catch(e) { console.warn('Archivio non leggibile, si ricrea.'); }

  const archiveIds = new Set((existingArchive.archive || []).map(e => e.id));
  const mergedArchive = [
    ...(existingArchive.archive || []),
    ...archived.filter(e => !archiveIds.has(e.id))
  ].sort((a, b) => new Date(b.date_start) - new Date(a.date_start));

  // 5. Categories (legge dal NUOVO campo category)
  const categoryMap = {
    socialita:  'Socialità & Cultura',
    cultura:    'Cultura & Incontri',
    esperienza: 'Esperienze',
    esclusivo:  'Solo Soci',
    su_invito:  'Su Invito'
  };
  const usedCats = [...new Set(formatsRaw.map(f => f.category).filter(Boolean))];
  const categories = usedCats.map(id => ({ id, label: categoryMap[id] || id }));

  // 6. Pricing tiers con sconti reali da config
  const pricing_tiers = {
    osservatore: { label: 'Osservatore', description: 'Ingresso standard' },
    custode:     { label: 'Custode',     description: `Sconto ${sc}% su tutti gli eventi` },
    damascato:   { label: 'Damascato',   description: `Sconto ${sd}% su tutti gli eventi` }
  };

  // 7. Scrivi damascati_events.json
  const eventsJson = {
    club: 'Il Salotto dei Damascati',
    last_updated: new Date().toISOString(),
    version: '3.0',
    config: { sconto_custode: sc, sconto_damascato: sd },
    pricing_tiers,
    categories,
    formats: formatsRaw.filter(f => f.active).map(f => formatToJson(f, config)),
    hosts: [{
      id: 'nicolaj', name: "Nicolaj D'Ortona", role: 'Fondatore',
      url: 'https://damascati.it/identita', image: ''
    }],
    events: upcoming
  };

  fs.writeFileSync('damascati_events.json', JSON.stringify(eventsJson, null, 2), 'utf8');
  console.log('✅ damascati_events.json scritto');

  // 8. Scrivi events_archive.json
  fs.writeFileSync('events_archive.json', JSON.stringify({
    club: 'Il Salotto dei Damascati',
    last_updated: new Date().toISOString(),
    version: '3.0',
    archive: mergedArchive
  }, null, 2), 'utf8');
  console.log('✅ events_archive.json scritto');

  console.log('🎉 Sync completato.');
}

main().catch(err => {
  console.error('❌ Errore sync:', err.message);
  process.exit(1);
});
