/**
 * Company / alias / hashtag matching.
 *
 * Real posts do not spell a company name the way its SEC registration does, so
 * every term is compiled into a tolerant pattern:
 *   - whitespace matches any run of spaces, dots, hyphens or underscores
 *     ("Rite Homes", "Rite-Homes", "Rite.Homes")
 *   - "&" also matches the word "and"
 *   - a trailing "." is optional ("CORP." matches "CORP")
 *   - matches must sit on a word boundary, so "Ritehomes" never fires inside
 *     "Ritehomesomething"
 *
 * The matcher reports the exact character ranges it hit, so the dashboard can
 * highlight them without re-running any of this logic in the browser.
 */

/** Term kinds, ordered by how much confidence a hit in each conveys. */
export const TERM_TYPES = ['name', 'alias', 'hashtag', 'handle'];

const TYPE_WEIGHT = { name: 4, alias: 3, hashtag: 2, handle: 2 };

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles one term into a tolerant, boundary-anchored pattern.
 * @param {string} term
 * @returns {RegExp} global + case-insensitive + unicode
 */
export function compileTerm(term) {
  const trimmed = String(term).trim();
  const hasTrailingDot = trimmed.endsWith('.');
  const core = hasTrailingDot ? trimmed.slice(0, -1) : trimmed;

  // "&" is not a regex metacharacter, so it survives escapeRegex untouched and
  // is swapped here. The word "and" gets the same treatment, which makes the
  // substitution work in both directions.
  const AMPERSAND_OR_AND = '(?:&|and)';

  let body = escapeRegex(core)
    .split(/\s+/)
    .map((word) => (word.toLowerCase() === 'and'
      ? AMPERSAND_OR_AND
      : word.replace(/&/g, AMPERSAND_OR_AND)))
    .join('[\\s._-]+');

  if (hasTrailingDot) body += '\\.?';

  // Boundaries use letter/number classes rather than \b so that a leading "#"
  // or "@" still anchors correctly.
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * Compiles the flat term list for one configured company.
 * @returns {Array<{companyId, companyName, term, type, pattern}>}
 */
function compileCompany(company) {
  const groups = [
    ['name', [company.name]],
    ['alias', company.aliases || []],
    ['hashtag', company.hashtags || []],
    ['handle', company.handles || []]
  ];

  const compiled = [];
  const seen = new Set();

  for (const [type, terms] of groups) {
    for (const term of terms) {
      const clean = String(term || '').trim();
      if (!clean) continue;

      const dedupeKey = `${type}:${clean.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      compiled.push({
        companyId: company.id,
        companyName: company.name,
        term: clean,
        type,
        pattern: compileTerm(clean)
      });
    }
  }

  // Longest term first, so "CEBU RITEHOMES DEVELOPMENT" wins over "Ritehomes".
  return compiled.sort((a, b) => b.term.length - a.term.length);
}

/** Collects every hit of one pattern in `text`. */
function findAll(pattern, text) {
  const hits = [];
  pattern.lastIndex = 0;

  let match = pattern.exec(text);
  while (match !== null) {
    hits.push({ start: match.index, end: match.index + match[0].length, matched: match[0] });

    // Zero-length matches would spin forever; nudge the cursor.
    if (match[0].length === 0) pattern.lastIndex += 1;
    match = pattern.exec(text);
  }

  return hits;
}

/** Merges overlapping ranges into the minimal covering set. */
export function mergeRanges(ranges) {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [{ ...sorted[0] }];

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

/**
 * Drops any match wholly contained inside an earlier, longer match for the
 * same company - that is how "Ritehomes" is suppressed when the full
 * "CEBU RITEHOMES DEVELOPMENT & REALTY CORP." already matched.
 */
function dropShadowedMatches(matches) {
  const ordered = [...matches].sort(
    (a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start)
  );

  const kept = [];
  for (const candidate of ordered) {
    const shadowed = kept.some(
      (existing) => existing.companyId === candidate.companyId &&
        candidate.start >= existing.start &&
        candidate.end <= existing.end
    );
    if (!shadowed) kept.push(candidate);
  }

  return kept;
}

export class Matcher {
  /** @param {Array<Object>} companies from config.companies */
  constructor(companies) {
    this.rebuild(companies);
  }

  /**
   * Recompiles every pattern in place.
   *
   * Done in place rather than by constructing a new Matcher because connectors,
   * the pipeline and the scheduler all hold a reference to this instance -
   * swapping the object would leave them pointing at stale terms after a live
   * config change.
   */
  rebuild(companies) {
    this.companies = companies || [];
    this.terms = this.companies.flatMap(compileCompany);
    this.excludes = new Map(
      this.companies.map((company) => [
        company.id,
        (company.exclude || [])
          .map((term) => String(term).trim())
          .filter(Boolean)
          .map((term) => ({ term, pattern: compileTerm(term) }))
      ])
    );

    return this;
  }

  /**
   * @param {string} text
   * @returns {{matched: boolean, matches: Array, companies: Array,
   *            highlights: Array, primaryCompanyId: string|null,
   *            excludedBy: Array}}
   */
  match(text) {
    const empty = {
      matched: false,
      matches: [],
      companies: [],
      highlights: [],
      primaryCompanyId: null,
      excludedBy: []
    };

    if (!text || typeof text !== 'string') return empty;

    const rawMatches = [];
    for (const entry of this.terms) {
      for (const hit of findAll(entry.pattern, text)) {
        rawMatches.push({
          companyId: entry.companyId,
          companyName: entry.companyName,
          term: entry.term,
          type: entry.type,
          matched: hit.matched,
          start: hit.start,
          end: hit.end
        });
      }
    }

    if (rawMatches.length === 0) return empty;

    // A company's exclude list only suppresses that company, never the others.
    const excludedBy = [];
    const suppressed = new Set();

    for (const [companyId, excludeTerms] of this.excludes) {
      for (const { term, pattern } of excludeTerms) {
        if (findAll(pattern, text).length > 0) {
          suppressed.add(companyId);
          excludedBy.push({ companyId, term });
          break;
        }
      }
    }

    const surviving = dropShadowedMatches(
      rawMatches.filter((entry) => !suppressed.has(entry.companyId))
    );

    if (surviving.length === 0) {
      return { ...empty, excludedBy };
    }

    // Rank companies by strongest term type, then by number of hits.
    const perCompany = new Map();
    for (const entry of surviving) {
      const existing = perCompany.get(entry.companyId) || {
        companyId: entry.companyId,
        companyName: entry.companyName,
        hits: 0,
        bestType: entry.type,
        bestWeight: 0,
        terms: []
      };

      existing.hits += 1;
      if (!existing.terms.includes(entry.term)) existing.terms.push(entry.term);

      const weight = TYPE_WEIGHT[entry.type] || 1;
      if (weight > existing.bestWeight) {
        existing.bestWeight = weight;
        existing.bestType = entry.type;
      }

      perCompany.set(entry.companyId, existing);
    }

    const companies = [...perCompany.values()].sort(
      (a, b) => b.bestWeight - a.bestWeight || b.hits - a.hits
    );

    return {
      matched: true,
      matches: surviving.sort((a, b) => a.start - b.start),
      companies,
      highlights: mergeRanges(surviving.map(({ start, end }) => ({ start, end }))),
      primaryCompanyId: companies[0].companyId,
      excludedBy
    };
  }

  /** Runs match() over several fields and merges the verdict. */
  matchFields(fields) {
    const perField = {};
    const allCompanies = new Map();
    let matched = false;

    for (const [fieldName, value] of Object.entries(fields)) {
      if (!value) continue;

      const result = this.match(value);
      perField[fieldName] = result;
      if (!result.matched) continue;

      matched = true;
      for (const company of result.companies) {
        const existing = allCompanies.get(company.companyId);
        if (existing) {
          existing.hits += company.hits;
          for (const term of company.terms) {
            if (!existing.terms.includes(term)) existing.terms.push(term);
          }
          if (company.bestWeight > existing.bestWeight) {
            existing.bestWeight = company.bestWeight;
            existing.bestType = company.bestType;
          }
        } else {
          allCompanies.set(company.companyId, { ...company, terms: [...company.terms] });
        }
      }
    }

    const companies = [...allCompanies.values()].sort(
      (a, b) => b.bestWeight - a.bestWeight || b.hits - a.hits
    );

    return {
      matched,
      companies,
      primaryCompanyId: companies.length ? companies[0].companyId : null,
      fields: perField
    };
  }

  /**
   * The terms to send to a platform's search API.
   *
   * Deliberately NOT the same as the terms used for matching. Querying every
   * alias and hashtag is expensive and pointless: YouTube's search.list costs
   * 100 quota units per term per poll against a 10,000/day allowance, so 13
   * terms buys only 7 polls a day. And it is redundant - searching "Ritehomes"
   * already returns videos naming "CEBU RITEHOMES DEVELOPMENT & REALTY CORP.",
   * because platform search tokenises loosely.
   *
   * So a company may declare `searchTerms` - a short list of distinctive
   * queries. Matching still runs against the full term list, so precision is
   * unchanged; only the number of paid API calls drops. A company with no
   * `searchTerms` falls back to all of its terms.
   */
  queryTerms({ includeHandles = false } = {}) {
    const explicit = [];
    const overridden = new Set();

    for (const company of this.companies) {
      const declared = (company.searchTerms || [])
        .map((term) => String(term).trim())
        .filter(Boolean);

      if (declared.length === 0) continue;

      overridden.add(company.id);
      explicit.push(...declared);
    }

    const derived = this.terms
      .filter((entry) => !overridden.has(entry.companyId))
      .filter((entry) => includeHandles || entry.type !== 'handle')
      .map((entry) => entry.term);

    return [...new Set([...explicit, ...derived])];
  }
}

export function createMatcher(companies) {
  return new Matcher(companies);
}
