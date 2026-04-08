// ─────────────────────────────────────────────────────────────────
// Netlify Function: submission-created
// Fires automatically on every Netlify Forms submission.
// Creates a lead in Inflatable Office with correct locationId
// routing per territory. Fails silently — email notifications
// already went out regardless of what happens here.
// ─────────────────────────────────────────────────────────────────

const https = require('https');

// ── Territory → IO Location ID map ──
const TERRITORY_TO_LOCATION = {
  'quote-new-york':      'POM New York',
  'quote-new-jersey':    'South Jersey/PA',
  'quote-philadelphia':  'South Jersey/PA',
  'quote-eastern-pa':    'Central PA',
  'quote-delaware':      'MDDE',
  'quote-maryland':      'POM-VA',
  'quote-virginia':      'POM-VA',
  'quote-florida':       'Orlando',
  'quote-connecticut':   'POM-Connecticut',
  'quote-massachusetts': 'POM New York',
};

// ── State code → IO Location ID (for corporate zip lookup) ──
const STATE_TO_LOCATION = {
  'NY': 'POM New York',
  'NJ': 'South Jersey/PA',
  'PA': 'South Jersey/PA', // overridden by zip check below
  'DE': 'MDDE',
  'MD': 'POM-VA',
  'VA': 'POM-VA',
  'FL': 'Orlando',
  'CT': 'POM-Connecticut',
  'MA': 'POM New York',
};

// ── Philadelphia territory zip codes ──
const PHILLY_ZIPS = new Set([
  "08002","08003","08004","08005","08006","08007","08009","08010",
  "08011","08012","08013","08015","08016","08017","08018","08019",
  "08020","08021","08023","08024","08025","08026","08027","08033",
  "08034","08035","08036","08037","08038","08039","08041","08043",
  "08046","08048","08049","08052","08053","08075","08079","08083",
  "08110","08111","08114","08118","18940","18954","18955","18972",
  "18973","18974","18980","18981","18982","18987","18988","18989",
  "19001","19003","19004","19007","19010","19012","19013","19014",
  "19015","19018","19020","19022","19023","19026","19027","19028",
  "19029","19030","19032","19033","19035","19036","19038","19040",
  "19041","19043","19044","19046","19047","19049","19050","19051",
  "19054","19063","19064","19065","19070","19074","19075","19078",
  "19079","19080","19081","19082","19083","19085","19086","19087",
  "19089","19090","19091","19093","19094","19095","19096","19099",
  "19101","19102","19103","19104","19105","19106","19107","19108",
  "19109","19110","19111","19112","19113","19114","19115","19116",
  "19118","19119","19120","19121","19122","19123","19124","19125",
  "19126","19127","19128","19129","19130","19131","19132","19133",
  "19134","19135","19136","19137","19138","19139","19140","19141",
  "19142","19143","19144","19145","19146","19147","19148","19149",
  "19150","19151","19152","19153","19154","19301","19312","19317",
  "19319","19342","19355","19373","19380",
]);

// ── Resolve locationId from form name + zip ──
function resolveLocationId(formName, zip, state) {
  // Direct territory form — easy lookup
  if (formName && TERRITORY_TO_LOCATION[formName]) {
    return TERRITORY_TO_LOCATION[formName];
  }

  // Corporate form — use zip/state to determine territory
  if (zip) {
    const z = String(zip).trim().substring(0, 5);
    if (PHILLY_ZIPS.has(z)) return 'South Jersey/PA';
  }

  if (state) {
    const s = String(state).trim().toUpperCase();
    // PA zip didn't match philly → Eastern PA
    if (s === 'PA') return 'Central PA';
    if (STATE_TO_LOCATION[s]) return STATE_TO_LOCATION[s];
  }

  // Final fallback — South Jersey/PA (Roger's home territory)
  return 'South Jersey/PA';
}

// ── Build notes string from form data ──
function buildNotes(data) {
  const parts = [];
  if (data.event_type)   parts.push(`Event Type: ${data.event_type}`);
  if (data.guest_count)  parts.push(`Guests: ${data.guest_count}`);
  if (data.surface)      parts.push(`Surface: ${data.surface}`);
  if (data.referral)     parts.push(`How they heard: ${data.referral}`);
  if (data.notes)        parts.push(`Notes: ${data.notes}`);
  parts.push('Source: Website Quote Form');
  return parts.join(' | ');
}

// ── Post to Zapier webhook → Inflatable Office ──
function postToIO(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'hooks.zapier.com',
      path: '/hooks/catch/26693121/u7mqaax/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main handler ──
exports.handler = async (event) => {
  try {
    // Netlify passes form data as JSON in the event body
    const body = JSON.parse(event.body);
    // Netlify submission-created events wrap data inside a 'payload' key
    const payload = body.payload || body;
    const data = payload.data || {};
    const formName = payload.form_name || '';

    // Skip spam / bot submissions
    if (data['bot-field']) {
      return { statusCode: 200, body: 'Bot submission ignored' };
    }

    const customerName = data.full_name || data.name || '';
    const locationId = resolveLocationId(
      formName,
      data.zip || data.eventzip || '',
      data.state || data.eventstate || ''
    );

    const leadPayload = {
      name:                 customerName,
      eventname:            customerName,
      email:                data.email || '',
      cellphone:            data.phone || data.cellphone || '',
      eventstartdate_text:  data.event_date || data.eventstartdate_text || '',
      eventstreet:          data.address || data.eventstreet || '',
      eventzip:             data.zip || data.eventzip || '',
      notes:                buildNotes(data),
      locationid:           locationId,
      status:               'Quote',
    };

    const result = await postToIO(leadPayload);
    console.log(`IO lead sent via Zapier — form: ${formName}, location: ${locationId}, status: ${result.status}`);

    return { statusCode: 200, body: JSON.stringify({ success: true, ioStatus: result.status }) };

  } catch (err) {
    // Fail silently — emails already went out, don't break anything
    console.error('IO lead creation error:', err.message);
    return { statusCode: 200, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
