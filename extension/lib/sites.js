// Feeds that popular sites provide but don't advertise on their pages. Pure functions.

/**
 * @param {string} input a URL the user pasted
 * @returns {{url: string, title: string}[]} likely feed URLs, best first (validated later by fetching)
 */
export function siteFeedCandidates(input) {
  let u;
  try { u = new URL(input); } catch { return []; }
  const host = u.hostname.replace(/^(www|m|old|new)\./, '').toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const out = [];
  const add = (url, title) => out.push({ url, title });

  // Reddit: subreddits, users, multireddits
  if (host === 'reddit.com') {
    if (parts[0] === 'r' && parts[1]) {
      const sort = ['new', 'top', 'rising'].includes(parts[2]) ? `${parts[2]}/` : '';
      add(`https://www.reddit.com/r/${parts[1]}/${sort}.rss`, `r/${parts[1]}${sort ? ` (${parts[2]})` : ''}`);
    } else if ((parts[0] === 'user' || parts[0] === 'u') && parts[1]) {
      add(`https://www.reddit.com/user/${parts[1]}/.rss`, `u/${parts[1]}`);
    }
  }

  // GitHub: repo releases/commits/tags, or a user's public activity
  if (host === 'github.com' && parts[0] && !['orgs', 'settings', 'notifications', 'explore', 'topics', 'marketplace'].includes(parts[0])) {
    if (parts[1]) {
      const repo = `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
      add(`https://github.com/${repo}/releases.atom`, `${repo} releases`);
      add(`https://github.com/${repo}/tags.atom`, `${repo} tags`);
      add(`https://github.com/${repo}/commits.atom`, `${repo} commits`);
    } else {
      add(`https://github.com/${parts[0]}.atom`, `${parts[0]} on GitHub`);
    }
  }

  // YouTube: playlists and /channel/ IDs (handles like /@name advertise their feed in the page)
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const list = u.searchParams.get('list');
    if (list) add(`https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(list)}`, 'YouTube playlist');
    if (parts[0] === 'channel' && parts[1]) add(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(parts[1])}`, 'YouTube channel');
  }

  // Bluesky profiles
  if (host === 'bsky.app' && parts[0] === 'profile' && parts[1]) {
    add(`https://bsky.app/profile/${parts[1]}/rss`, `${parts[1]} on Bluesky`);
  }

  // Mastodon & other fediverse servers: https://server/@user and /tags/x
  if (parts.length === 1 && /^@[\w.-]+$/.test(parts[0]) && host !== 'medium.com' && host !== 'youtube.com') {
    add(`${u.origin}/${parts[0]}.rss`, `${parts[0]}@${u.hostname}`);
  }
  if (parts[0] === 'tags' && parts[1] && parts.length === 2) add(`${u.origin}/tags/${parts[1]}.rss`, `#${parts[1]}`);

  // Medium: @user, publications, and custom subdomains
  if (host === 'medium.com' && parts[0]) add(`https://medium.com/feed/${parts[0]}`, `${parts[0]} on Medium`);
  else if (host.endsWith('.medium.com')) add(`${u.origin}/feed`, host);

  // Substack and Tumblr subdomains
  if (host.endsWith('.substack.com')) add(`${u.origin}/feed`, host.replace('.substack.com', ''));
  if (host.endsWith('.tumblr.com')) add(`${u.origin}/rss`, host.replace('.tumblr.com', ''));

  return out;
}
