const DEFAULT_STOPWORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '有', '和', '就', '不',
  '也', '都', '很', '还', '这', '那', '啊', '呀', '哦', '嗯', '一个', '什么', '可以',
  '然后', '就是', '不是', '没有', '我们', '你们', '他们'
]);

function textOf(message) {
  return String(message?.content ?? message?.text ?? '').trim();
}

function validMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((message) => textOf(message));
}

function countMatches(text, pattern) {
  return String(text).match(pattern)?.length || 0;
}

export class Analyzer {
  constructor(config = {}) {
    this.config = config;
    this.stopWords = new Set(config.stopWords || DEFAULT_STOPWORDS);
  }

  async analyze(messages, { conversation = [], targetQQ } = {}) {
    const normalized = validMessages(messages);
    const allMessages = validMessages(conversation);
    const stats = {
      totalMessages: normalized.length,
      avgLength: this.calcAvgLength(normalized),
      medianLength: this.calcMedianLength(normalized),
      emojiHabits: this.extractEmojiHabits(normalized),
      punctuationHabits: this.extractPunctuationHabits(normalized),
      replyPatterns: this.extractReplyPatterns(normalized, { conversation: allMessages, targetQQ }),
      topWords: this.extractTopWords(normalized),
      phraseHabits: this.extractPhraseHabits(normalized),
      timeDistribution: this.extractTimeDistribution(normalized),
      sentenceStyle: this.extractSentenceStyle(normalized),
      dialogueActs: this.extractDialogueActs(normalized),
      sampleWindow: this.getSampleWindow(normalized)
    };
    return stats;
  }

  calcAvgLength(messages) {
    const values = validMessages(messages).map((message) => [...textOf(message)].length);
    if (!values.length) return 0;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  calcMedianLength(messages) {
    const values = validMessages(messages).map((message) => [...textOf(message)].length).sort((a, b) => a - b);
    if (!values.length) return 0;
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
  }

  extractEmojiHabits(messages) {
    const emojiRegex = /\[([^\]]+)\]|[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu;
    const counts = {};
    validMessages(messages).forEach((message) => {
      for (const emoji of textOf(message).match(emojiRegex) || []) counts[emoji] = (counts[emoji] || 0) + 1;
    });
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([emoji, count]) => ({ emoji, count }));
  }

  extractPunctuationHabits(messages) {
    const patterns = {
      exclamation: 0,
      question: 0,
      ellipsis: 0,
      dots: 0,
      comma: 0,
      noPunctuation: 0,
      trailingPunctuation: {}
    };
    validMessages(messages).forEach((message) => {
      const text = textOf(message);
      patterns.exclamation += countMatches(text, /[！!]/gu);
      patterns.question += countMatches(text, /[？?]/gu);
      patterns.ellipsis += countMatches(text, /(?:\.\.\.|…+)/gu);
      patterns.dots += countMatches(text, /。{2,}/gu);
      patterns.comma += countMatches(text, /[,，]/gu);
      if (!/[。！？.!?…]/u.test(text)) patterns.noPunctuation += 1;
      const trailing = text.match(/[。！？.!?…~～]+$/u)?.[0];
      if (trailing) patterns.trailingPunctuation[trailing] = (patterns.trailingPunctuation[trailing] || 0) + 1;
    });
    return patterns;
  }

  extractReplyPatterns(messages, { conversation = [], targetQQ } = {}) {
    const target = validMessages(messages);
    const gaps = [];
    for (let index = 1; index < target.length; index += 1) {
      const previous = Date.parse(target[index - 1].time || '')
      const current = Date.parse(target[index].time || '');
      if (Number.isFinite(previous) && Number.isFinite(current) && current >= previous && current - previous < 300000) {
        gaps.push((current - previous) / 1000);
      }
    }
    const responseGaps = [];
    if (conversation.length && targetQQ !== undefined) {
      for (let index = 0; index < conversation.length; index += 1) {
        const current = conversation[index];
        if (String(current.qq ?? current.sender?.user_id ?? '') !== String(targetQQ)) continue;
        const previous = conversation[index - 1];
        if (!previous || String(previous.qq ?? previous.sender?.user_id ?? '') === String(targetQQ)) continue;
        const before = Date.parse(previous.time || '');
        const after = Date.parse(current.time || '');
        if (Number.isFinite(before) && Number.isFinite(after) && after >= before && after - before < 900000) {
          responseGaps.push((after - before) / 1000);
        }
      }
    }
    const average = (values) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    return {
      avgGapSeconds: average(gaps),
      fastReplyCount: gaps.filter((gap) => gap < 30).length,
      totalPairs: gaps.length,
      avgResponseSeconds: average(responseGaps),
      responsePairs: responseGaps.length
    };
  }

  extractTopWords(messages, limit = 20) {
    const counts = new Map();
    validMessages(messages).forEach((message) => {
      for (const term of this.extractTerms(textOf(message))) {
        counts.set(term, (counts.get(term) || 0) + 1);
      }
    });
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
      .slice(0, limit)
      .map(([word, count]) => ({ word, count }));
  }

  extractPhraseHabits(messages, limit = 20) {
    const counts = new Map();
    validMessages(messages).forEach((message) => {
      const text = textOf(message).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
      const seen = new Set();
      for (let size = 2; size <= Math.min(6, text.length); size += 1) {
        for (let index = 0; index <= text.length - size; index += 1) {
          const phrase = text.slice(index, index + size);
          if (this.stopWords.has(phrase) || seen.has(phrase) || /^[a-z\d]+$/iu.test(phrase)) continue;
          seen.add(phrase);
          counts.set(phrase, (counts.get(phrase) || 0) + 1);
        }
      }
    });
    return [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
      .slice(0, limit)
      .map(([phrase, count]) => ({ phrase, count }));
  }

  extractTerms(text) {
    const source = String(text || '').toLowerCase();
    const terms = new Set();
    for (const run of source.match(/[㐀-鿿]+/gu) || []) {
      for (let size = 2; size <= Math.min(3, run.length); size += 1) {
        for (let index = 0; index <= run.length - size; index += 1) {
          const term = run.slice(index, index + size);
          if (!this.stopWords.has(term)) terms.add(term);
        }
      }
    }
    for (const word of source.match(/[a-z\d_]{2,}/giu) || []) {
      if (!this.stopWords.has(word)) terms.add(word);
    }
    return terms;
  }

  extractTimeDistribution(messages) {
    const hours = new Array(24).fill(0);
    validMessages(messages).forEach((message) => {
      const date = new Date(message.time || '');
      if (Number.isFinite(date.getTime())) hours[date.getHours()] += 1;
    });
    const max = Math.max(...hours, 0);
    return { hours, peakHour: max ? hours.indexOf(max) : null };
  }

  extractSentenceStyle(messages) {
    const styles = { short: 0, medium: 0, long: 0, multiLine: 0 };
    validMessages(messages).forEach((message) => {
      const text = textOf(message);
      const length = [...text].length;
      if (length < 10) styles.short += 1;
      else if (length < 30) styles.medium += 1;
      else styles.long += 1;
      if (/\r?\n/u.test(text)) styles.multiLine += 1;
    });
    return styles;
  }

  extractDialogueActs(messages) {
    const acts = { question: 0, agreement: 0, disagreement: 0, joke: 0, empathy: 0, explanation: 0, statement: 0 };
    validMessages(messages).forEach((message) => {
      const text = textOf(message);
      let matched = false;
      if (/[？?]$|^(?:怎么|为什么|咋|啥|谁|哪|是否|能不能)/u.test(text)) { acts.question += 1; matched = true; }
      if (/(?:哈哈|笑死|绷不住|乐|草|离谱)/u.test(text)) { acts.joke += 1; matched = true; }
      if (/(?:同意|确实|对的|是的|没错|对对对)/u.test(text)) { acts.agreement += 1; matched = true; }
      if (/(?:不是|不对|我不同意|别吧|不至于)/u.test(text)) { acts.disagreement += 1; matched = true; }
      if (/(?:抱抱|节哀|难过|心疼|加油|辛苦了)/u.test(text)) { acts.empathy += 1; matched = true; }
      if (/(?:因为|所以|也就是说|简单来说|意思是)/u.test(text)) { acts.explanation += 1; matched = true; }
      if (!matched) acts.statement += 1;
    });
    return acts;
  }

  getSampleWindow(messages) {
    const valid = validMessages(messages);
    const times = valid.map((message) => message.time).filter(Boolean).sort();
    return { from: times[0] || null, to: times[times.length - 1] || null };
  }

  async generateProfileWithLLM(messages, stats) {
    const recentMessages = validMessages(messages).slice(-80).map((message) => textOf(message)).join('\n');
    return `分析以下已获授权的聊天样本，输出严格 JSON。\n\n样本：\n${recentMessages}\n\n确定性统计：\n${JSON.stringify(stats)}\n\n输出字段：version、tone、catchphrases、sentence_pattern、emoji_style、dialogueActs、topics、boundaries、personality_summary、confidence、evidenceIds。证据不足字段填 unknown，不要编造现实经历或身份。`;
  }
}
