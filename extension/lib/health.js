// Feed health classification for the "Feed health" report. Pure functions.

const DAY = 86400000;

/**
 * @param {object[]} feeds
 * @param {Record<string,{recent:number,latest:number,total:number,unread:number,oldest?:number,complete?:boolean}>} stats
 *        recent = posts published in the last `windowDays`; oldest = oldest of those; complete = stored posts go back further
 * @returns {object[]} one row per feed with perWeek and flags {failing, inactive, noisy}
 */
export function assessFeeds(feeds, stats, { now = Date.now(), windowDays = 30, inactiveDays = 90 } = {}) {
  const rows = feeds.map((f) => {
    const s = stats[f.id] || { recent: 0, latest: 0, total: 0, unread: 0 };
    // Rate over the time the stored posts actually cover. A new or busy feed's history may span only a
    // few days of the window (feed documents hold the latest N items), so dividing by the whole window
    // would understate it. At least 3 days, so a single fresh post doesn't look like a firehose.
    const coveredDays = s.complete || !s.oldest ? windowDays : Math.min(windowDays, Math.max(3, (now - s.oldest) / DAY));
    const perWeek = (s.recent / coveredDays) * 7;
    const failing = !!f.lastError && ((f.errorCount || 0) >= 3 || now - (f.lastSuccess || f.addedAt || now) > 3 * DAY);
    const inactive = s.latest ? now - s.latest > inactiveDays * DAY : now - (f.addedAt || now) > 7 * DAY;
    return { feed: f, ...s, perWeek, failing, inactive, noisy: false };
  });
  const active = rows.map((r) => r.perWeek).filter((n) => n > 0).sort((a, b) => a - b);
  const median = active.length ? active[Math.floor(active.length / 2)] : 0;
  for (const r of rows) r.noisy = r.perWeek >= 20 && r.perWeek >= 3 * median;
  return rows;
}
