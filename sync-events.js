/**
 * sync-events.js
 * Legge eventi e formats da Supabase e scrive:
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

function buildPricingEvent(evt) {
  if (evt.pricing_free) return { free_with_booking: true };
  return {
    osservatore: evt.prezzo_osservatore ?? null,
    custode:     evt.prezzo_custode     ?? null,
    damascato:   evt.prezzo_damascato   ?? null
  };
}

function buildPricingFormat(fmt) {
  if (!fmt.prezzo_osservatore_default && !fmt.prezzo_custode_default) {
    return { free_with_booking: true };
  }
  return {
    osservatore: fmt.prezzo_osservatore_default ?? null,
    custode:     fmt.prezzo_custode_default     ?? null,
    damascato:   fmt.prezzo_damascato_default   ?? null
  };
}

function eventToJson(evt, fmt) {
  return {
    id:          evt.id,
    format_id:   evt.format_id,
    title:       evt.title,
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
    pricing_event:        buildPricingEvent(evt),
    description_override: evt.description_override || '',
    media: {
      image_card: evt.image_card || (fmt ? fmt.immagine_default : '') || ''
    },
    registration: {
      url: evt.registration_url || ''
    },
    google_calendar_id: evt.google_calendar_id || ''
  };
}

function formatToJson(fmt) {
  return {
    format_id:         fmt.id,
    base_title:        fmt.nome,
    description_short: fmt.descrizione_breve  || '',
    description_long:  fmt.descrizione_completa || '',
    image_url:         fmt.immagine_default    || '',
    category:          fmt.categoria ? [fmt.categoria] : [],
    pricing:           buildPricingFormat(fmt),
    price_variable:    false,
    duration_hours:    fmt.durata_ore || null,
    visibility:        fmt.visibilita_default || 'public'
  };
}

async function main() {
  console.log('🔄 Avvio sync Supabase → JSON...');

  // 1. Carica dati
  const [eventiRaw, formatsRaw] = await Promise.all([
    query('eventi', '?published=eq.true&order=date_start.asc'),
    query('formats', '?attivo=eq.true&order=id.asc')
  ]);

  console.log(`📅 Eventi trovati: ${eventiRaw.length}`);
  console.log(`📋 Formats trovati: ${formatsRaw.length}`);

  const formatsMap = {};
  formatsRaw.forEach(f => formatsMap[f.id] = f);

  // 2. Separa eventi futuri da archiviati
  const now = new Date();
  const upcoming = [];
  const archived = [];

  for (const evt of eventiRaw) {
    // Aggiorna automaticamente publish_at
    if (evt.publish_at && new Date(evt.publish_at) > now) {
      console.log(`⏳ Evento ${evt.id} non ancora da pubblicare (publish_at: ${evt.publish_at})`);
      continue;
    }
    const fmt = formatsMap[evt.format_id] || null;
    const evtJson = eventToJson(evt, fmt);
    if (isExpired(evt)) {
      archived.push(evtJson);
    } else {
      upcoming.push(evtJson);
    }
  }

  console.log(`✅ Upcoming: ${upcoming.length} | 📦 Archived: ${archived.length}`);

  // 3. Carica archivio esistente per non perdere eventi già archiviati manualmente
  let existingArchive = { archive: [] };
  try {
    if (fs.existsSync('events_archive.json')) {
      existingArchive = JSON.parse(fs.readFileSync('events_archive.json', 'utf8'));
    }
  } catch(e) { console.warn('Archivio esistente non leggibile, si ricrea.'); }

  // Merge archivio — evita duplicati per id
  const archiveIds = new Set((existingArchive.archive || []).map(e => e.id));
  const newArchived = archived.filter(e => !archiveIds.has(e.id));
  const mergedArchive = [...(existingArchive.archive || []), ...newArchived]
    .sort((a, b) => new Date(b.date_start) - new Date(a.date_start));

  // 4. Costruisci categories da formats
  const categoryMap = {
    socialita:   'Socialità & Cultura',
    cultura:     'Cultura & Incontri',
    esperienza:  'Esperienze',
    esclusivo:   'Solo Soci'
  };
  const usedCats = [...new Set(formatsRaw.map(f => f.categoria).filter(Boolean))];
  const categories = usedCats.map(id => ({ id, label: categoryMap[id] || id }));

  // 5. Costruisci pricing_tiers
  const pricing_tiers = {
    osservatore: { label: 'Osservatore', description: 'Ingresso standard' },
    custode:     { label: 'Custode',     description: 'Sconto 15% su tutti gli eventi' },
    damascato:   { label: 'Damascato',   description: 'Sconto 33% su tutti gli eventi' }
  };

  // 6. Scrivi damascati_events.json
  const eventsJson = {
    club: 'Il Salotto dei Damascati',
    last_updated: new Date().toISOString(),
    version: '2.0',
    pricing_tiers,
    categories,
    formats: formatsRaw.filter(f => f.attivo).map(formatToJson),
    hosts: [{
      id: 'nicolaj',
      name: 'Nicolaj D\'Ortona',
      role: 'Fondatore',
      url: 'https://damascati.it/chi-siamo',
      image: ''
    }],
    events: upcoming
  };

  fs.writeFileSync('damascati_events.json', JSON.stringify(eventsJson, null, 2), 'utf8');
  console.log('✅ damascati_events.json scritto');

  // 7. Scrivi events_archive.json
  const archiveJson = {
    club: 'Il Salotto dei Damascati',
    last_updated: new Date().toISOString(),
    version: '2.0',
    archive: mergedArchive
  };

  fs.writeFileSync('events_archive.json', JSON.stringify(archiveJson, null, 2), 'utf8');
  console.log('✅ events_archive.json scritto');

  console.log('🎉 Sync completato.');
}

main().catch(err => {
  console.error('❌ Errore sync:', err.message);
  process.exit(1);
});
