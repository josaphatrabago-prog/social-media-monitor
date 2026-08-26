/**
 * Lexicon sentiment scoring, tuned for Philippine property and construction
 * chatter.
 *
 * Three things a generic English word list gets wrong on this data set, and
 * what is done about them here:
 *
 *   1. Comments mix English with Tagalog and Cebuano ("nindot kaayo",
 *      "walang update"), so the lexicon covers all three.
 *   2. Industry complaints are neutral-sounding in isolation - "turnover",
 *      "permit", "punch list" - and only carry sentiment as phrases, so
 *      multi-word entries are scored before single tokens.
 *   3. Bisaya puts its intensifier *after* the adjective ("nindot kaayo"),
 *      so intensifiers are looked for on both sides of a match.
 *
 * Scores are deliberately explainable: every hit is returned with its weight,
 * so the dashboard can show why a mention was flagged.
 */

/* ------------------------------------------------------------------ lexicon */

/** Single tokens. Weight range is -3 (worst) to +3 (best). */
const WORD_SCORES = {
  // --- English positive
  love: 3, loved: 3, excellent: 3, outstanding: 3, perfect: 3, amazing: 3,
  fantastic: 3, superb: 3, awesome: 3, best: 3, brilliant: 3, flawless: 3,
  great: 2, good: 2, happy: 2, satisfied: 2, recommend: 2, recommended: 2,
  recommending: 2, reliable: 2, professional: 2, responsive: 2, quality: 2,
  beautiful: 2, stunning: 2, solid: 2, durable: 2, trusted: 2, trustworthy: 2,
  smooth: 2, efficient: 2, helpful: 2, honest: 2, transparent: 2, worth: 2,
  impressed: 2, thankful: 2, grateful: 2, legit: 2, sturdy: 2,
  nice: 1, decent: 1, fine: 1, okay: 1, fast: 1, clean: 1, modern: 1,
  affordable: 1, accommodating: 1, thanks: 1, congrats: 1, congratulations: 1,

  // --- English negative
  scam: -3, scammer: -3, scammers: -3, fraud: -3, fraudulent: -3, estafa: -3,
  swindle: -3, thief: -3, stealing: -3, lawsuit: -3, sue: -3, suing: -3,
  horrible: -3, terrible: -3, awful: -3, worst: -3, disgusting: -3, nightmare: -3,
  hate: -3, useless: -3, collapsed: -3, collapse: -3, dangerous: -3,
  bad: -2, poor: -2, disappointed: -2, disappointing: -2, disappointment: -2,
  angry: -2, frustrated: -2, frustrating: -2, complaint: -2, complaints: -2,
  complain: -2, complaining: -2, refund: -2, delayed: -2, delay: -2, delays: -2,
  defect: -2, defects: -2, defective: -2, substandard: -2, shoddy: -2,
  unfinished: -2, incomplete: -2, unresponsive: -2, ignored: -2, ghosted: -2,
  overpriced: -2, misleading: -2, misrepresented: -2, deceptive: -2, liar: -2,
  lying: -2, lied: -2, broken: -2, cracked: -2, cracks: -2, leaking: -2,
  leaks: -2, leak: -2, seepage: -2, flooded: -2, flooding: -2, abandoned: -2,
  unlicensed: -2, unpermitted: -2, violation: -2, violations: -2, dispute: -2,
  regret: -2, avoid: -2, warning: -2, warn: -2, sketchy: -2, shady: -2,
  slow: -1, expensive: -1, pricey: -1, waiting: -1, concern: -1, concerned: -1,
  concerns: -1, issue: -1, issues: -1, problem: -1, problems: -1, crack: -1,
  dusty: -1, noisy: -1, confusing: -1, hassle: -1, pending: -1, stuck: -1,

  // --- Tagalog / Filipino
  maganda: 2, ganda: 2, magaling: 2, galing: 2, husay: 2, mahusay: 2,
  matibay: 2, tibay: 2, sulit: 2, salamat: 2, maayos: 2, mabilis: 1,
  astig: 2, aprubado: 1, malinis: 1, presyo: 0,
  pangit: -2, palpak: -2, sablay: -2, budol: -3, niloko: -3, nagloko: -3,
  manloloko: -3, kalokohan: -2, reklamo: -2, sumbong: -2, lugi: -2,
  basura: -2, walanghiya: -3, gago: -3, bulok: -2, tagas: -2, tulo: -1,

  // --- Cebuano / Bisaya
  maayo: 2, nindot: 2, kanindot: 2, salamat_kaayo: 3, hayahay: 1,
  paspas: 1, barato: 1, tinuod: 1,
  ngil: 0, bati: -2, hugaw: -2, guba: -2, buak: -2, kawatan: -3,
  limbongan: -3, sayang: -2, hinay: -1, mahal_kaayo: -1
};

/**
 * Multi-word entries, scored before single tokens. These are where most of the
 * industry-specific signal lives.
 */
const PHRASE_SCORES = {
  // --- positive
  'highly recommend': 3,
  'highly recommended': 3,
  'strongly recommend': 3,
  'top notch': 3,
  'well built': 3,
  'well constructed': 3,
  'worth every peso': 3,
  'worth it': 2,
  'on schedule': 2,
  'ahead of schedule': 3,
  'on time': 2,
  'as promised': 2,
  'no issues': 2,
  'no problems': 2,
  'smooth transaction': 3,
  'hassle free': 2,
  'good quality': 3,
  'great quality': 3,
  'excellent workmanship': 3,
  'good workmanship': 2,
  'fast turnover': 2,
  'clean turnover': 2,
  'very satisfied': 3,
  'thank you': 1,
  'god bless': 1,
  'nindot kaayo': 3,
  'maayo kaayo': 3,
  'salamat kaayo': 2,
  'sulit ang bayad': 3,
  'okay naman': 1,

  // --- negative
  'not recommended': -3,
  'do not recommend': -3,
  'would not recommend': -3,
  'stay away': -3,
  'false advertising': -3,
  'poor quality': -3,
  'poor workmanship': -3,
  'bad workmanship': -3,
  'delayed turnover': -3,
  'turnover delay': -3,
  'no permit': -3,
  'without permit': -3,
  'no update': -2,
  'no updates': -2,
  'still waiting': -2,
  'still no': -2,
  'no response': -2,
  'not responding': -2,
  'never responded': -3,
  'no refund': -3,
  'demand refund': -3,
  'asking for refund': -2,
  'small claims': -3,
  'legal action': -3,
  'work stoppage': -3,
  'stop work': -2,
  'structural issue': -3,
  'structural issues': -3,
  'structural defect': -3,
  'hollow blocks crumbling': -3,
  'punch list': -1,
  'walang update': -3,
  'walang kwenta': -3,
  'wala pa': -2,
  'hindi tapos': -3,
  'hindi pa tapos': -3,
  'hindi maayos': -3,
  'wala silay tubag': -3,
  'wala pa nahuman': -3,
  'dili maayo': -3,
  'ang bagal': -2,
  'sobrang bagal': -3,
  'grabe ang delay': -3
};

/** Flip and dampen the next scored term. */
const NEGATORS = new Set([
  'not', 'no', 'never', 'none', 'cannot', 'cant', "can't", 'dont', "don't",
  'doesnt', "doesn't", 'didnt', "didn't", 'isnt', "isn't", 'wasnt', "wasn't",
  'wont', "won't", 'aint', "ain't", 'without', 'hardly', 'barely', 'nor',
  'hindi', 'di', 'wala', 'walang', 'walay', 'dili', 'ayaw'
]);

/** Amplify the adjacent scored term. */
const INTENSIFIERS = new Set([
  'very', 'so', 'really', 'extremely', 'super', 'totally', 'absolutely',
  'highly', 'incredibly', 'seriously', 'truly', 'such', 'damn',
  'sobrang', 'sobra', 'grabe', 'talagang', 'napaka', 'ang'
]);

/** Bisaya and Tagalog put these *after* the adjective: "nindot kaayo". */
const POSTFIX_INTENSIFIERS = new Set(['kaayo', 'talaga', 'gyud', 'jud', 'sobra', 'na kaayo']);

/** Soften the adjacent scored term. */
const DIMINISHERS = new Set([
  'slightly', 'somewhat', 'kinda', 'kind', 'sorta', 'a', 'bit', 'little',
  'medyo', 'konti', 'gamay', 'parang'
]);

const EMOJI_SCORES = {
  '❤': 3, '\u{1F60D}': 3, '\u{1F525}': 2, '\u{1F44F}': 2, '\u{1F44D}': 2,
  '\u{1F600}': 2, '\u{1F603}': 2, '\u{1F604}': 2, '\u{1F60A}': 2, '\u{1F929}': 3,
  '\u{1F64F}': 1, '✅': 1, '✨': 2, '\u{1F3C6}': 2, '\u{1F495}': 3,
  '\u{1F621}': -3, '\u{1F620}': -3, '\u{1F92C}': -3, '\u{1F44E}': -2,
  '\u{1F612}': -2, '\u{1F61E}': -2, '\u{1F622}': -2, '\u{1F62D}': -2,
  '\u{1F926}': -2, '\u{1F92E}': -3, '\u{1F4A9}': -3, '⚠': -1, '\u{1F6A8}': -2
};

/* ------------------------------------------------------------------ scoring */

const NEGATION_WINDOW = 3;
const MODIFIER_WINDOW = 2;
const NEGATION_FACTOR = -0.75;
const INTENSIFIER_FACTOR = 1.5;
const DIMINISHER_FACTOR = 0.6;
const MAX_PHRASE_WORDS = 4;

/** Saturation constant: keeps the display score inside (-1, 1). */
const SATURATION = 3;

/**
 * Sentence terminators are kept as tokens so they can act as barriers. Without
 * them a negator leaks into the next sentence and flips its meaning - in
 * "Do not recommend. Demand refund", the "not" would turn the refund demand
 * into a positive.
 */
const TOKEN_PATTERN = /[\p{L}\p{N}']+|\p{Extended_Pictographic}|[.!?;\n]/gu;
const BARRIER_TOKENS = new Set(['.', '!', '?', ';', '\n']);

function tokenize(text) {
  return String(text).toLowerCase().match(TOKEN_PATTERN) || [];
}

function isBarrier(token) {
  return token !== undefined && BARRIER_TOKENS.has(token);
}

/** Phrases grouped by word count, longest first. */
function buildPhraseIndex(phraseScores) {
  const byLength = new Map();

  for (const [phrase, weight] of Object.entries(phraseScores)) {
    const words = phrase.split(/\s+/);
    if (!byLength.has(words.length)) byLength.set(words.length, new Map());
    byLength.get(words.length).set(words.join(' '), weight);
  }

  return [...byLength.entries()].sort((a, b) => b[0] - a[0]);
}

/** Turns config extras into a {term: weight} map. */
function normaliseExtras(entries, defaultWeight) {
  const result = {};

  for (const entry of entries || []) {
    if (typeof entry === 'string') {
      if (entry.trim()) result[entry.trim().toLowerCase()] = defaultWeight;
      continue;
    }
    if (entry && typeof entry === 'object' && entry.term) {
      result[String(entry.term).trim().toLowerCase()] = Number(entry.weight) || defaultWeight;
    }
  }

  return result;
}

export class SentimentAnalyzer {
  /**
   * @param {Object} options config.sentiment
   */
  constructor(options = {}) {
    this.positiveThreshold = options.positiveThreshold ?? 1;
    this.negativeThreshold = options.negativeThreshold ?? -1;

    const extraPositive = normaliseExtras(options.extraPositive, 2);
    const extraNegative = normaliseExtras(options.extraNegative, -2);
    const extras = { ...extraPositive, ...extraNegative };

    this.words = { ...WORD_SCORES };
    this.phrases = { ...PHRASE_SCORES };

    // A multi-word extra becomes a phrase; a single word joins the word list.
    for (const [term, weight] of Object.entries(extras)) {
      if (term.includes(' ')) this.phrases[term] = weight;
      else this.words[term] = weight;
    }

    this.phraseIndex = buildPhraseIndex(this.phrases);
  }

  /** Longest phrase starting at `index`, or null. */
  #phraseAt(tokens, index) {
    for (const [wordCount, phrases] of this.phraseIndex) {
      if (wordCount > MAX_PHRASE_WORDS) continue;
      if (index + wordCount > tokens.length) continue;

      const span = tokens.slice(index, index + wordCount);
      if (span.some(isBarrier)) continue;

      const weight = phrases.get(span.join(' '));
      if (weight !== undefined) {
        return { term: span.join(' '), weight, length: wordCount };
      }
    }
    return null;
  }

  /** Base weight of a single token, or null when it carries no sentiment. */
  #wordAt(token) {
    const weight = this.words[token] ?? EMOJI_SCORES[token];
    if (weight === undefined || weight === 0) return null;
    return { term: token, weight, length: 1 };
  }

  /**
   * @param {string} text
   * @returns {{label: 'positive'|'neutral'|'negative', raw: number,
   *            score: number, magnitude: number, hits: Array, tokens: number}}
   */
  analyze(text) {
    const tokens = tokenize(text);
    const wordCount = tokens.filter((token) => !isBarrier(token)).length;

    if (wordCount === 0) {
      return { label: 'neutral', raw: 0, score: 0, magnitude: 0, hits: [], tokens: 0 };
    }

    const hits = [];
    let raw = 0;
    let index = 0;

    // Where the previously scored term ended. A negator before this point
    // belongs to that term, not to the one being scored now.
    let previousHitEnd = 0;

    while (index < tokens.length) {
      const found = this.#phraseAt(tokens, index) || this.#wordAt(tokens[index]);

      if (!found) {
        index += 1;
        continue;
      }

      let weight = found.weight;
      let negated = false;
      let amplified = false;
      let softened = false;

      // Negation looks back a few tokens, but never past a sentence boundary
      // or past the term scored before this one.
      const lookbackFloor = Math.max(index - NEGATION_WINDOW, previousHitEnd);
      for (let position = index - 1; position >= lookbackFloor; position -= 1) {
        const previous = tokens[position];
        if (isBarrier(previous)) break;
        if (NEGATORS.has(previous)) {
          negated = true;
          break;
        }
      }

      const modifierFloor = Math.max(index - MODIFIER_WINDOW, previousHitEnd);
      for (let position = index - 1; position >= modifierFloor; position -= 1) {
        const previous = tokens[position];
        if (isBarrier(previous)) break;
        if (INTENSIFIERS.has(previous)) { amplified = true; break; }
        if (DIMINISHERS.has(previous)) { softened = true; break; }
      }

      const after = tokens[index + found.length];
      if (POSTFIX_INTENSIFIERS.has(after)) amplified = true;

      if (negated) weight *= NEGATION_FACTOR;
      if (amplified) weight *= INTENSIFIER_FACTOR;
      if (softened) weight *= DIMINISHER_FACTOR;

      weight = Math.round(weight * 100) / 100;
      raw += weight;

      hits.push({
        term: found.term,
        weight,
        base: found.weight,
        negated,
        amplified,
        softened,
        tokenIndex: index
      });

      index += found.length;
      previousHitEnd = index;
    }

    // Shouting and repeated exclamation marks amplify whatever is already there.
    const emphasis = this.#emphasisFactor(text);
    raw = Math.round(raw * emphasis * 100) / 100;

    return {
      label: this.label(raw),
      raw,
      score: Math.round((raw / (Math.abs(raw) + SATURATION)) * 1000) / 1000,
      magnitude: Math.abs(raw),
      hits,
      tokens: wordCount
    };
  }

  /** 1.0 to ~1.3, based on shouting and exclamation marks. */
  #emphasisFactor(text) {
    let factor = 1;

    const exclamations = (String(text).match(/!/g) || []).length;
    if (exclamations > 0) factor += Math.min(exclamations, 3) * 0.05;

    const shoutedWords = String(text).match(/\b[A-Z]{4,}\b/g) || [];
    if (shoutedWords.length >= 2) factor += 0.1;

    return Math.min(factor, 1.3);
  }

  label(raw) {
    if (raw >= this.positiveThreshold) return 'positive';
    if (raw <= this.negativeThreshold) return 'negative';
    return 'neutral';
  }
}

export function createSentimentAnalyzer(options) {
  return new SentimentAnalyzer(options);
}

export { WORD_SCORES, PHRASE_SCORES, EMOJI_SCORES };
