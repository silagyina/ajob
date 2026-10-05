// Local development bridge only. No dependencies, telemetry or persistent offer cache.
const BASE = 'https://api.francetravail.io/partenaire/offresdemploi/v2';
const AUTH = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=/partenaire';
export class APIError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const clean = value => typeof value === 'string' && value.trim() ? value.trim() : null;
export function safeURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return null;
    return url.href;
  } catch { return null; }
}
export function normalize(job) {
  if (!job || !/^[A-Za-z0-9_-]{1,64}$/.test(job.id ?? '') || !clean(job.intitule)) throw new APIError(502, 'invalid_response');
  const partners = (job.origineOffre?.partenaires ?? []).map(p => ({ name: clean(p.nom), url: safeURL(p.url) })).filter(p => p.name);
  return {
    id: job.id, title: clean(job.intitule), company: clean(job.entreprise?.nom),
    location: clean(job.lieuTravail?.libelle), salary: clean(job.salaire?.libelle),
    contract: clean(job.typeContratLibelle) ?? clean(job.typeContrat),
    schedule: [clean(job.dureeTravailLibelle), clean(job.dureeTravailLibelleConverti)].filter(Boolean).join(' · ') || null,
    experience: clean(job.experienceLibelle), description: clean(job.description),
    publishedAt: clean(job.dateCreation), updatedAt: clean(job.dateActualisation), partners,
    // Open the source offer, never submit a candidate or expose contact details.
    applicationURL: safeURL(job.origineOffre?.urlOrigine) ?? safeURL(job.contact?.urlPostulation)
  };
}
export function searchParameters(input) {
  const allowed = new Set(['q', 'commune', 'distance', 'contract', 'fullTime', 'experience', 'salary', 'period', 'offset']);
  for (const key of input.keys()) if (!allowed.has(key) || input.getAll(key).length !== 1) throw new APIError(400, 'invalid_query');
  const out = new URLSearchParams({ sort: '1' });
  const q = input.get('q')?.trim();
  if (q) {
    const expressions = q.split(',').map(value => value.trim());
    if (q.length > 150 || expressions.some(value => value.length < 2)) throw new APIError(400, 'invalid_query');
    out.set('motsCles', expressions.join(','));
  }
  const commune = input.get('commune');
  if (commune) {
    if (!/^(?:\d{5}|2[AB]\d{3})$/.test(commune)) throw new APIError(400, 'invalid_query');
    out.set('commune', commune);
    const d = Number(input.get('distance') ?? 25);
    if (!Number.isInteger(d) || d < 0 || d > 100) throw new APIError(400, 'invalid_query');
    out.set('distance', String(d));
  } else if (input.has('distance')) throw new APIError(400, 'invalid_query');
  for (const [name, target, values] of [
    ['contract', 'typeContrat', ['CDI', 'CDD', 'MIS', 'LIB']]
  ]) {
    const value = input.get(name);
    if (value) { if (!values.includes(value)) throw new APIError(400, 'invalid_query'); out.set(target, value); }
  }
  const fullTime = input.get('fullTime');
  if (fullTime) {
    if (!['true', 'false'].includes(fullTime)) throw new APIError(400, 'invalid_query');
    out.set('dureeHebdo', fullTime === 'true' ? '1' : '2');
  }
  const experience = input.get('experience');
  if (experience) {
    if (!['D', '1', '2', '3'].includes(experience)) throw new APIError(400, 'invalid_query');
    out.set(experience === 'D' ? 'experienceExigence' : 'experience', experience);
  }
  // The period selection alone must never activate the optional salary filter.
  const rawSalary = (input.get('salary') ?? '').trim().replace(/[\u00a0\u202f]/g, ' ');
  if (rawSalary) {
    if (!/^(?:[0-9]+|[0-9]{1,3}(?: [0-9]{3})+)(?:[.,][0-9]{1,2})?$/.test(rawSalary)) throw new APIError(400, 'invalid_salary');
    const salary = Number(rawSalary.replace(/ /g, '').replace(',', '.'));
    if (!Number.isFinite(salary) || salary > 1000000) throw new APIError(400, 'invalid_salary');
    if (salary > 0) {
      const period = input.get('period');
      if (!['H', 'M', 'A', 'C'].includes(period)) throw new APIError(400, 'invalid_salary');
      out.set('salaireMin', String(salary));
      out.set('periodeSalaire', period);
    }
  }
  const offset = Number(input.get('offset') ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 3000 || offset % 20) throw new APIError(400, 'invalid_query');
  out.set('range', `${offset}-${Math.min(offset + 19, 3149)}`);
  return { parameters: out, offset };
}
export function createService({ clientID, clientSecret, fetcher = fetch, now = Date.now }) {
  let token = null, validUntil = 0, tokenPromise = null, lastCall = 0, queue = Promise.resolve();
  // Serialize upstream requests to stay below the public request quota, including retries.
  async function request(url, options) {
    const run = queue.then(async () => {
      const delay = Math.max(0, lastCall + 300 - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      lastCall = Date.now();
      try { return await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
      catch { throw new APIError(503, 'unavailable'); }
    });
    queue = run.catch(() => {});
    return run;
  }
  async function json(response) {
    try { return await response.json(); } catch { throw new APIError(502, 'invalid_response'); }
  }
  async function accessToken() {
    if (token && now() < validUntil) return token;
    if (!tokenPromise) tokenPromise = (async () => {
      if (!clientID || !clientSecret) throw new APIError(503, 'configuration');
      const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientID, client_secret: clientSecret, scope: 'api_offresdemploiv2 o2dsoffre' });
      const response = await request(AUTH, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!response.ok) throw new APIError(response.status === 429 ? 429 : 503, response.status === 429 ? 'rate_limit' : 'authorization');
      const value = await json(response);
      if (typeof value.access_token !== 'string' || !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0) throw new APIError(502, 'invalid_response');
      token = value.access_token;
      validUntil = now() + Math.max(1, Number(value.expires_in) - 60) * 1000;
      return token;
    })().finally(() => { tokenPromise = null; });
    return tokenPromise;
  }
  async function get(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const usedToken = await accessToken();
      const response = await request(`${BASE}${path}`, { headers: { Authorization: `Bearer ${usedToken}`, Accept: 'application/json' } });
      if (response.status === 401 && attempt === 0) {
        if (token === usedToken) { token = null; validUntil = 0; }
        continue;
      }
      if (response.status === 204) return { data: null, range: null };
      if (!response.ok) {
        const code = ({ 400: 'upstream_query', 401: 'authorization', 403: 'authorization', 404: 'not_found', 429: 'rate_limit' })[response.status] ?? 'unavailable';
        throw new APIError([400, 404, 429].includes(response.status) ? response.status : 503, code);
      }
      return { data: await json(response), range: response.headers.get('content-range') };
    }
    throw new APIError(503, 'authorization');
  }
  let countries = null, communes = null, contracts = null;
  async function reference(name) {
    const { data } = await get(`/referentiel/${name}`);
    if (!Array.isArray(data)) throw new APIError(502, 'invalid_response');
    return data;
  }
  return {
    async cities(query) {
      if (query.length < 2 || query.length > 100) throw new APIError(400, 'invalid_query');
      communes ??= await reference('communes');
      const fold = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return communes.filter(c => fold(c.libelle).includes(fold(query)) || String(c.code).startsWith(query))
        .slice(0, 40).map(c => ({ id: String(c.code), name: String(c.libelle), postalCode: c.codePostal ? String(c.codePostal) : null }));
    },
    async search(input) {
      const { parameters, offset } = searchParameters(input);
      // Use a single geographic scope: a selected INSEE commune + radius,
      // or France for nationwide searches. Do not combine country and commune.
      if (!parameters.has('commune')) {
        countries ??= await reference('pays');
        const france = countries.find(c => String(c.libelle).trim().toLowerCase() === 'france');
        if (!france || france.code == null) throw new APIError(502, 'invalid_response');
        parameters.set('paysContinent', String(france.code));
      }
      if (parameters.has('typeContrat')) {
        contracts ??= await reference('typesContrats');
        if (!contracts.some(c => String(c.code) === parameters.get('typeContrat'))) throw new APIError(400, 'contract_unavailable');
      }
      const { data, range } = await get(`/offres/search?${parameters}`);
      if (data === null) return { jobs: [], nextOffset: null, capped: false };
      if (!Array.isArray(data.resultats)) throw new APIError(502, 'invalid_response');
      const jobs = data.resultats.map(normalize);
      const match = range?.match(/(?:\w+\s+)?(\d+)-(\d+)\/(\d+|\*)/);
      const total = match && match[3] !== '*' ? Number(match[3]) : null;
      const more = jobs.length === 20 && (total === null || offset + jobs.length < total);
      return { jobs, nextOffset: more && offset < 3000 ? offset + 20 : null, capped: more && offset >= 3000 };
    },
    async detail(id) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new APIError(400, 'invalid_query');
      const { data } = await get(`/offres/${encodeURIComponent(id)}`);
      if (data === null) throw new APIError(404, 'not_found');
      return normalize(data);
    }
  };
}
