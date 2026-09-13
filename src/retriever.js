import fs from 'fs/promises';

const STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '有', '和', '就', '不',
  '也', '都', '很', '还', '这', '那', '啊', '呀', '哦', '嗯', '一个', '什么', '可以'
]);

function contentOf(sample) {
  return String(sample?.content ?? sample?.text ?? sample?.message ?? '').trim();
}

function normalizedContent(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function extractKeywords(text) {
  const source = String(text || '').toLowerCase();
  const terms = new Set();
  const chineseRuns = source.match(/[㐀-鿿]+/g) || [];
  for (const run of chineseRuns) {
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) terms.add(run);
      continue;
    }
    for (let size = 2; size <= Math.min(3, run.length); size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) {
        const term = run.slice(index, index + size);
        if (!STOPWORDS.has(term)) terms.add(term);
      }
    }
  }
  for (const word of source.match(/[a-z0-9_]{2,}/g) || []) terms.add(word);
  return [...terms];
}

function flattenSamples(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['samples', 'messages', 'targetMessages', 'allMessages', 'data']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

/** Lightweight, local Chinese n-gram retriever for style examples. */
export class Retriever {
  constructor(samples = []) {
    this.samples = [];
    this.addSamples(samples);
  }

  addSamples(samples) {
    for (const sample of flattenSamples(samples)) {
      const content = contentOf(sample);
      if (!content) continue;
      this.samples.push({ ...sample, content, _terms: extractKeywords(content) });
    }
    return this;
  }

  clear() {
    this.samples = [];
  }

  async loadJSON(pathOrData) {
    const data = typeof pathOrData === 'string'
      ? JSON.parse(await fs.readFile(pathOrData, 'utf-8'))
      : pathOrData;
    this.addSamples(data);
    return this;
  }

  static async fromJSON(pathOrData) {
    return new Retriever().loadJSON(pathOrData);
  }

  retrieve(query, { groupId, limit = 5, excludeIds = [] } = {}) {
    const queryTerms = new Set(extractKeywords(query));
    const excluded = new Set(excludeIds.map(String));
    const seen = new Set();
    const scoped = groupId === undefined || groupId === null
      ? this.samples
      : this.samples.filter((sample) => String(sample.groupId ?? sample.group_id ?? '') === String(groupId));

    const results = [];
    for (const sample of scoped) {
      const id = sample.id ?? sample.message_id;
      if (id !== undefined && excluded.has(String(id))) continue;
      const fingerprint = normalizedContent(sample.content);
      if (!fingerprint || seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      const overlap = sample._terms.filter((term) => queryTerms.has(term));
      const score = overlap.length === 0
        ? 0
        : overlap.length / Math.sqrt(Math.max(sample._terms.length, 1) * Math.max(queryTerms.size, 1));
      results.push({
        ...Object.fromEntries(Object.entries(sample).filter(([key]) => key !== '_terms')),
        score: Number(score.toFixed(4)),
        matchedKeywords: overlap
      });
    }

    return results
      .filter((result) => queryTerms.size === 0 || result.score > 0)
      .sort((left, right) => right.score - left.score || String(right.time || '').localeCompare(String(left.time || '')))
      .slice(0, Math.min(Math.max(Number(limit) || 5, 1), 5));
  }

  search(query, options) {
    return this.retrieve(query, options);
  }
}
