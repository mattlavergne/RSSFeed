// Filter rules / keyword alerts. Pure functions — no browser APIs.
//
// rule = {
//   id, name, enabled,
//   field: 'title' | 'content' | 'any' | 'author' | 'link',
//   op: 'contains' | 'not_contains' | 'regex' | 'equals',
//   value: string, caseSensitive: bool,
//   feedIds: string[]  (empty = all feeds),
//   actions: Array<'notify' | 'star' | 'highlight' | 'markRead' | 'delete'>
// }

export const RULE_ACTIONS = {
  notify: 'Send a notification (keyword alert)',
  highlight: 'Highlight in the list',
  star: 'Star (save for later)',
  markRead: 'Mark as read',
  delete: 'Hide / delete',
};

export const RULE_FIELDS = { any: 'Title or content', title: 'Title', content: 'Content', author: 'Author', link: 'Link URL' };
export const RULE_OPS = { contains: 'contains', not_contains: 'does not contain', equals: 'is exactly', regex: 'matches regex' };

function fieldValue(post, field) {
  switch (field) {
    case 'title': return post.title || '';
    case 'content': return post.text || post.snippet || '';
    case 'author': return post.author || '';
    case 'link': return post.link || '';
    default: return `${post.title || ''}\n${post.text || post.snippet || ''}`;
  }
}

const regexCache = new Map();
function getRegex(rule) {
  const key = `${rule.value}\u0000${rule.caseSensitive ? '' : 'i'}`;
  if (!regexCache.has(key)) {
    let re = null;
    try { re = new RegExp(rule.value, rule.caseSensitive ? 'u' : 'iu'); } catch { re = null; }
    regexCache.set(key, re);
  }
  return regexCache.get(key);
}

export function validateRule(rule) {
  if (!rule.value || !String(rule.value).trim()) return 'Enter a keyword or pattern';
  if (rule.op === 'regex' && !getRegex(rule)) return 'Invalid regular expression';
  if (!rule.actions?.length) return 'Choose at least one action';
  return null;
}

export function ruleMatches(rule, post) {
  if (!rule.enabled || !rule.value) return false;
  if (rule.feedIds?.length && !rule.feedIds.includes(post.feedId)) return false;
  const hay = fieldValue(post, rule.field);
  const cs = !!rule.caseSensitive;
  switch (rule.op) {
    case 'regex': {
      const re = getRegex(rule);
      return !!re && re.test(hay);
    }
    case 'equals':
      return cs ? hay.trim() === rule.value.trim() : hay.trim().toLowerCase() === rule.value.trim().toLowerCase();
    case 'not_contains':
    case 'contains': {
      // Comma-separated keywords: any of them matches.
      const words = rule.value.split(',').map((w) => w.trim()).filter(Boolean);
      const h = cs ? hay : hay.toLowerCase();
      const any = words.some((w) => h.includes(cs ? w : w.toLowerCase()));
      return rule.op === 'contains' ? any : !any;
    }
    default:
      return false;
  }
}

/**
 * Apply rules to freshly fetched posts (mutates read/starred/highlight).
 * @returns {{ kept: object[], alerts: object[] }} posts to store, and posts that triggered a "notify" action
 */
export function applyRules(rules, posts) {
  const active = rules.filter((r) => r.enabled);
  const kept = [];
  const alerts = [];
  for (const post of posts) {
    let drop = false, alert = false;
    for (const rule of active) {
      if (!ruleMatches(rule, post)) continue;
      for (const action of rule.actions || []) {
        if (action === 'delete') drop = true;
        else if (action === 'markRead') post.read = 1;
        else if (action === 'star') post.starred = 1;
        else if (action === 'highlight') post.highlight = 1;
        else if (action === 'notify') alert = true;
      }
      post.matchedRules = [...(post.matchedRules || []), rule.id];
    }
    if (drop) continue;
    kept.push(post);
    if (alert) alerts.push(post);
  }
  return { kept, alerts };
}
