/** Matching and sentiment: the two things a false result here is worst for. */
import { assert, describe, test } from './harness.js';
import { createMatcher, compileTerm, mergeRanges } from '../src/core/matcher.js';
import { createSentimentAnalyzer } from '../src/core/sentiment.js';

const COMPANIES = [
  {
    id: 'cebu-ritehomes',
    name: 'CEBU RITEHOMES DEVELOPMENT & REALTY CORP.',
    aliases: ['CEBU RITEHOMES', 'Cebu Rite Homes', 'Ritehomes Realty', 'Ritehomes'],
    hashtags: ['#Ritehomes', '#CebuRitehomes'],
    handles: ['@ritehomes'],
    exclude: ['fan page']
  },
  {
    id: 'roven-technic',
    name: 'ROVEN TECHNIC CONSTRUCTION',
    aliases: ['ROVEN TECHNIC', 'Roven Construction'],
    hashtags: ['#RovenTechnic'],
    handles: [],
    exclude: []
  }
];

describe('matcher', () => {
  const matcher = createMatcher(COMPANIES);

  test('matches the full registered name', () => {
    const result = matcher.match('Bought from CEBU RITEHOMES DEVELOPMENT & REALTY CORP. last year');
    assert.ok(result.matched);
    assert.equal(result.primaryCompanyId, 'cebu-ritehomes');
    assert.equal(result.companies[0].bestType, 'name');
  });

  test('treats "and" and "&" as interchangeable', () => {
    const result = matcher.match('cebu ritehomes development and realty corp is fine');
    assert.equal(result.companies[0].bestType, 'name', 'should match the full name, not just an alias');
  });

  test('tolerates punctuation and hyphens inside a term', () => {
    for (const text of ['Cebu Rite-Homes', 'Cebu.Rite.Homes', 'Cebu  Rite   Homes']) {
      assert.ok(matcher.match(`about ${text} today`).matched, `should match "${text}"`);
    }
  });

  test('makes a trailing period optional', () => {
    assert.ok(matcher.match('CEBU RITEHOMES DEVELOPMENT & REALTY CORP').matched);
  });

  test('respects word boundaries', () => {
    assert.notOk(matcher.match('Ritehomesomething is unrelated').matched);
    assert.notOk(matcher.match('xxRitehomes').matched);
  });

  test('matches hashtags and handles', () => {
    const hashtag = matcher.match('love #CebuRitehomes and #RovenTechnic');
    assert.equal(hashtag.companies.length, 2);

    const handle = matcher.match('cc @ritehomes please respond');
    assert.equal(handle.companies[0].bestType, 'handle');
  });

  test('suppresses only the excluded company', () => {
    const result = matcher.match('ritehomes fan page and Roven Construction update');
    assert.equal(result.primaryCompanyId, 'roven-technic');
    assert.notOk(
      result.companies.some((company) => company.companyId === 'cebu-ritehomes'),
      'excluded brand should be suppressed'
    );
    assert.equal(result.excludedBy[0].term, 'fan page');
  });

  test('prefers the longest term and does not double-count nested ones', () => {
    const result = matcher.match('CEBU RITEHOMES DEVELOPMENT & REALTY CORP. announced today');
    assert.equal(result.matches.length, 1, 'nested aliases must be shadowed by the full name');
    assert.equal(result.highlights.length, 1);
  });

  test('reports highlight ranges that index the original text', () => {
    const text = 'Update from Roven Construction this week';
    const result = matcher.match(text);
    const { start, end } = result.highlights[0];
    assert.equal(text.slice(start, end), 'Roven Construction');
  });

  test('is case insensitive', () => {
    assert.ok(matcher.match('ROVEN TECHNIC').matched);
    assert.ok(matcher.match('roven technic').matched);
    assert.ok(matcher.match('Roven Technic').matched);
  });

  test('returns a clean miss for unrelated text', () => {
    const result = matcher.match('Great weather in Cebu today');
    assert.notOk(result.matched);
    assert.deepEqual(result.companies, []);
  });

  test('matchFields merges verdicts across fields', () => {
    const result = matcher.matchFields({
      title: 'Roven Construction site tour',
      body: 'Also mentions #CebuRitehomes'
    });
    assert.ok(result.matched);
    assert.equal(result.companies.length, 2);
  });

  test('rebuild() swaps terms in place', () => {
    const local = createMatcher(COMPANIES);
    assert.ok(local.match('Ritehomes').matched);

    local.rebuild([{ id: 'other', name: 'Totally Different Corp', aliases: [] }]);
    assert.notOk(local.match('Ritehomes').matched, 'old terms should be gone');
    assert.ok(local.match('Totally Different Corp').matched);
  });

  test('queryTerms is de-duplicated and excludes handles by default', () => {
    const terms = matcher.queryTerms();
    assert.equal(terms.length, new Set(terms).size, 'no duplicates');
    assert.notOk(terms.includes('@ritehomes'));
    assert.ok(matcher.queryTerms({ includeHandles: true }).includes('@ritehomes'));
  });

  test('compileTerm escapes regex metacharacters', () => {
    const pattern = compileTerm('C++ (Cebu) Corp.');
    assert.ok(pattern.test('working with C++ (Cebu) Corp today'));
  });

  test('mergeRanges collapses overlaps', () => {
    assert.deepEqual(
      mergeRanges([{ start: 0, end: 5 }, { start: 3, end: 9 }, { start: 20, end: 25 }]),
      [{ start: 0, end: 9 }, { start: 20, end: 25 }]
    );
  });
});

describe('sentiment', () => {
  const analyzer = createSentimentAnalyzer({ positiveThreshold: 1, negativeThreshold: -1 });

  test('scores clear positives and negatives', () => {
    assert.equal(analyzer.analyze('Excellent workmanship, highly recommend').label, 'positive');
    assert.equal(analyzer.analyze('Terrible quality, total scam').label, 'negative');
  });

  test('returns neutral for factual text', () => {
    assert.equal(analyzer.analyze('Site visit scheduled for Tuesday at 9am').label, 'neutral');
  });

  test('handles negation', () => {
    assert.equal(analyzer.analyze('This is not good').label, 'negative');
    assert.equal(analyzer.analyze('The unit is not bad').label, 'positive');
  });

  test('does not let negation cross a sentence boundary', () => {
    // "not" belongs to the first sentence; the refund demand stays negative.
    const result = analyzer.analyze('Do not recommend. Demand refund now.');
    assert.equal(result.label, 'negative');

    const refund = result.hits.find((hit) => hit.term === 'demand refund');
    assert.ok(refund, 'phrase should be scored');
    assert.notOk(refund.negated, 'must not be flipped by the previous sentence');
  });

  test('does not let negation reach past an already-scored term', () => {
    const result = analyzer.analyze('not delayed and quality work');
    const quality = result.hits.find((hit) => hit.term === 'quality');
    assert.notOk(quality.negated);
  });

  test('scores multi-word phrases before single words', () => {
    const result = analyzer.analyze('delayed turnover again');
    assert.includes(result.hits.map((hit) => hit.term), 'delayed turnover');
    assert.equal(result.hits.length, 1, 'the phrase should consume "delayed"');
  });

  test('applies intensifiers on both sides', () => {
    const prefix = analyzer.analyze('very good work');
    const postfix = analyzer.analyze('nindot kaayo');
    assert.ok(prefix.hits[0].amplified, 'English intensifier precedes');
    assert.ok(postfix.raw >= 3, 'Bisaya intensifier follows');
  });

  test('handles Tagalog and Bisaya complaints', () => {
    assert.equal(analyzer.analyze('Walang update sa turnover, reklamo na ko').label, 'negative');
    assert.equal(analyzer.analyze('Hindi pa tapos ang amenities').label, 'negative');
    assert.equal(analyzer.analyze('Maayo kaayo ang trabaho, salamat').label, 'positive');
  });

  test('scores emoji', () => {
    assert.equal(analyzer.analyze('the new unit \u{1F60D}\u{1F525}').label, 'positive');
    assert.equal(analyzer.analyze('this again \u{1F621}').label, 'negative');
  });

  test('keeps the display score inside -1..1', () => {
    const extreme = analyzer.analyze('scam fraud estafa horrible worst nightmare disgusting'.repeat(5));
    assert.ok(extreme.score > -1 && extreme.score < 0, `score out of range: ${extreme.score}`);
  });

  test('empty and punctuation-only input is neutral with no hits', () => {
    for (const input of ['', '   ', '...', '!!!']) {
      const result = analyzer.analyze(input);
      assert.equal(result.label, 'neutral', `"${input}" should be neutral`);
      assert.equal(result.hits.length, 0);
    }
  });

  test('config thresholds move the boundaries', () => {
    const strict = createSentimentAnalyzer({ positiveThreshold: 5, negativeThreshold: -5 });
    assert.equal(strict.analyze('nice').label, 'neutral', 'a weak positive is neutral when strict');
    assert.equal(analyzer.analyze('nice').label, 'positive');
  });

  test('accepts extra lexicon entries from config', () => {
    const custom = createSentimentAnalyzer({
      extraNegative: ['brownout', { term: 'no water', weight: -3 }],
      extraPositive: ['aircon']
    });

    assert.equal(custom.analyze('brownout again').label, 'negative');
    assert.equal(custom.analyze('no water since Monday').label, 'negative');
    assert.equal(custom.analyze('aircon included').label, 'positive');
  });

  test('exposes the terms behind a score', () => {
    const result = analyzer.analyze('poor workmanship and cracked walls');
    assert.ok(result.hits.length >= 2);
    for (const hit of result.hits) {
      assert.ok(typeof hit.weight === 'number');
      assert.ok(typeof hit.term === 'string');
    }
  });
});

describe('search terms vs match terms', () => {
  test('without searchTerms, every term is queried', () => {
    const matcher = createMatcher(COMPANIES);
    const terms = matcher.queryTerms();

    assert.includes(terms, 'CEBU RITEHOMES DEVELOPMENT & REALTY CORP.');
    assert.includes(terms, '#Ritehomes');
    assert.ok(terms.length >= 10, `expected the full term list, got ${terms.length}`);
  });

  test('searchTerms narrows what gets queried without touching matching', () => {
    // YouTube's search.list costs 100 quota units per term per poll, so the
    // query list has to be short even though the match list stays long.
    const companies = COMPANIES.map((company) => ({
      ...company,
      searchTerms: company.id === 'cebu-ritehomes' ? ['Ritehomes'] : ['Roven Technic']
    }));

    const matcher = createMatcher(companies);
    assert.deepEqual(matcher.queryTerms(), ['Ritehomes', 'Roven Technic']);

    // Matching precision must be unchanged: the full registered name still
    // resolves as a name-level hit, not as the shorter alias.
    const result = matcher.match('Toured the CEBU RITEHOMES DEVELOPMENT & REALTY CORP. site');
    assert.equal(result.companies[0].companyId, 'cebu-ritehomes');
    assert.equal(result.companies[0].bestType, 'name');

    // And hashtag-only mentions still match even though no hashtag is queried.
    assert.ok(matcher.match('great work #RovenTechnic').matched);
  });

  test('searchTerms is per company, so one can opt in and the other not', () => {
    const companies = [
      { ...COMPANIES[0], searchTerms: ['Ritehomes'] },
      COMPANIES[1]
    ];

    const terms = createMatcher(companies).queryTerms();

    assert.includes(terms, 'Ritehomes');
    assert.notOk(
      terms.includes('CEBU RITEHOMES'),
      'the overridden company must contribute only its searchTerms'
    );
    assert.includes(terms, 'ROVEN TECHNIC CONSTRUCTION');
  });

  test('empty or whitespace searchTerms falls back to the full list', () => {
    const companies = COMPANIES.map((company) => ({ ...company, searchTerms: ['', '   '] }));
    assert.ok(createMatcher(companies).queryTerms().length >= 10);
  });
});

describe('real-world false positives', () => {
  /**
   * "Ritehomes.com real estate group" is an unrelated US company with ~118
   * YouTube videos. Searching the bare alias "Ritehomes" returns all of them,
   * and every title matched the Cebu client before the exclusion was added -
   * filing another continent's marketing as client mentions.
   */
  const OTHER_COMPANY_TITLES = [
    'Ritehomes.com Virtual Agent',
    'Ritehomes.com Culture',
    'How To Buy a Home With Ritehomes.com Explained',
    'Who we are by Ritehomes.com',
    'Ritehomes.com the agents who gives back.'
  ];

  const CONFIGURED = [
    {
      id: 'cebu-ritehomes',
      name: 'CEBU RITEHOMES DEVELOPMENT & REALTY CORP.',
      aliases: ['CEBU RITEHOMES', 'Cebu Rite Homes', 'Ritehomes Realty', 'Ritehomes'],
      hashtags: ['#Ritehomes'],
      handles: [],
      exclude: ['Ritehomes.com']
    }
  ];

  test('the unrelated US company is excluded', () => {
    const matcher = createMatcher(CONFIGURED);

    for (const title of OTHER_COMPANY_TITLES) {
      assert.notOk(matcher.match(title).matched, `should reject: ${title}`);
    }
  });

  test('genuine local mentions still match despite the exclusion', () => {
    const matcher = createMatcher(CONFIGURED);

    const genuine = [
      'Site tour at CEBU RITEHOMES DEVELOPMENT & REALTY CORP. today',
      'Nindot kaayo ang Ritehomes subdivision sa Mandaue',
      'Bought a unit from Cebu Rite Homes last year',
      'Walang update from Ritehomes, 8 months na'
    ];

    for (const text of genuine) {
      const result = matcher.match(text);
      assert.ok(result.matched, `should match: ${text}`);
      assert.equal(result.companies[0].companyId, 'cebu-ritehomes');
    }
  });

  test('the exclusion is scoped to the company that declares it', () => {
    const matcher = createMatcher([
      ...CONFIGURED,
      { id: 'roven-technic', name: 'ROVEN TECHNIC CONSTRUCTION', aliases: [], exclude: [] }
    ]);

    // One post naming both: Ritehomes is suppressed, Roven Technic is not.
    const result = matcher.match('Compared Ritehomes.com with ROVEN TECHNIC CONSTRUCTION');
    assert.equal(result.primaryCompanyId, 'roven-technic');
    assert.notOk(result.companies.some((entry) => entry.companyId === 'cebu-ritehomes'));
  });
});
