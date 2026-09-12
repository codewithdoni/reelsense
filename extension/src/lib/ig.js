// ReelSense — Instagram payload normalizer.
//
// Instagram ships several shapes for the same object (REST v1, GraphQL
// `xdt_*` connections, shortcode media) and renames fields every few weeks.
// Instead of hard-coding response paths that rot, we walk the payload and
// pick out anything that *looks like* a user, a reel or a comment.
// That keeps capture working across shape changes without a code edit.

const SHORTCODE = /^[A-Za-z0-9_-]{5,20}$/;

function num(...vals) {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(+v)) return +v;
    if (v && typeof v === "object" && typeof v.count === "number") return v.count;
  }
  return null;
}

function text(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v;
    if (v && typeof v === "object") {
      if (typeof v.text === "string" && v.text.trim()) return v.text;
      const edge = v?.edges?.[0]?.node?.text;
      if (typeof edge === "string" && edge.trim()) return edge;
    }
  }
  return null;
}

// --- shape detectors -------------------------------------------------------

function looksLikeReel(o) {
  if (!o || typeof o !== "object") return false;
  const code = o.code || o.shortcode;
  if (typeof code !== "string" || !SHORTCODE.test(code)) return false;
  const isVideo =
    o.media_type === 2 ||
    o.is_video === true ||
    Array.isArray(o.video_versions) ||
    typeof o.video_url === "string" ||
    o.product_type === "clips" ||
    o.clips_metadata != null ||
    typeof o.video_duration === "number";
  const hasCounts =
    num(o.play_count, o.ig_play_count, o.view_count, o.video_play_count) !== null ||
    num(o.like_count, o.edge_media_preview_like, o.edge_liked_by) !== null;
  return isVideo && hasCounts;
}

function looksLikeUser(o) {
  if (!o || typeof o !== "object") return false;
  if (typeof o.username !== "string") return false;
  return (
    num(o.follower_count, o.edge_followed_by) !== null ||
    typeof o.biography === "string" ||
    typeof o.is_business_account === "boolean" ||
    typeof o.account_type === "string"
  );
}

function looksLikeComment(o) {
  if (!o || typeof o !== "object") return false;
  if (typeof o.text !== "string" || !o.text.trim()) return false;
  const hasAuthor = o.user?.username || o.owner?.username || o.username;
  const hasId = o.pk || o.id;
  return Boolean(hasAuthor && hasId && (o.created_at || o.created_at_utc || o.taken_at));
}

// --- mappers ---------------------------------------------------------------

export function mapReel(o) {
  const music =
    o.clips_metadata?.music_info?.music_asset_info ||
    o.clips_metadata?.original_sound_info ||
    null;
  const videoUrl =
    o.video_versions?.[0]?.url || o.video_url || o.video_versions?.url || null;

  return {
    code: o.code || o.shortcode,
    id: o.pk || o.id || null,
    username: o.user?.username || o.owner?.username || null,
    caption: text(o.caption, o.edge_media_to_caption, o.caption_text) || "",
    views: num(o.play_count, o.ig_play_count, o.view_count, o.video_play_count) || 0,
    likes: num(o.like_count, o.edge_media_preview_like, o.edge_liked_by) || 0,
    comments: num(
      o.comment_count,
      o.edge_media_to_comment,
      o.edge_media_to_parent_comment
    ) || 0,
    taken_at: o.taken_at || o.taken_at_timestamp || o.device_timestamp || null,
    duration: o.video_duration || null,
    is_original_audio: music?.should_mute_audio === undefined
      ? Boolean(o.clips_metadata?.original_sound_info)
      : Boolean(o.clips_metadata?.original_sound_info),
    audio_title:
      music?.title ||
      o.clips_metadata?.music_info?.music_asset_info?.title ||
      (o.clips_metadata?.original_sound_info ? "Original audio" : null),
    video_url: videoUrl,
    thumbnail:
      o.image_versions2?.candidates?.[0]?.url ||
      o.display_url ||
      o.thumbnail_src ||
      null,
  };
}

export function mapUser(o) {
  return {
    username: o.username,
    id: o.pk || o.id || null,
    full_name: o.full_name || "",
    biography: o.biography || "",
    followers: num(o.follower_count, o.edge_followed_by) || 0,
    following: num(o.following_count, o.edge_follow) || 0,
    media_count: num(o.media_count, o.edge_owner_to_timeline_media) || 0,
    category: o.category || o.category_name || null,
    is_business: Boolean(o.is_business_account || o.is_professional_account),
    is_verified: Boolean(o.is_verified),
    external_url: o.external_url || null,
    profile_pic: o.profile_pic_url || o.profile_pic_url_hd || null,
  };
}

export function mapComment(o) {
  return {
    id: String(o.pk || o.id),
    text: o.text,
    username: o.user?.username || o.owner?.username || o.username || null,
    likes: num(o.comment_like_count, o.like_count, o.edge_liked_by) || 0,
    created_at: o.created_at || o.created_at_utc || o.taken_at || null,
  };
}

// --- extraction ------------------------------------------------------------

/**
 * Walk an arbitrary Instagram payload and pull out every reel, user and
 * comment it contains, wherever they are nested.
 */
export function extract(payload, maxNodes = 40000) {
  const reels = new Map();
  const users = new Map();
  const comments = new Map();
  const seen = new Set();
  let visited = 0;

  const stack = [payload];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    if (++visited > maxNodes) break;

    if (Array.isArray(node)) {
      for (const v of node) stack.push(v);
      continue;
    }

    try {
      if (looksLikeReel(node)) {
        const r = mapReel(node);
        const prev = reels.get(r.code);
        // Prefer the richer record (detail views carry video_url + full caption).
        if (!prev || (r.video_url && !prev.video_url) || r.caption.length > prev.caption.length) {
          reels.set(r.code, { ...(prev || {}), ...r });
        }
      } else if (looksLikeUser(node)) {
        const u = mapUser(node);
        const prev = users.get(u.username);
        if (!prev || u.followers > prev.followers || u.biography.length > prev.biography.length) {
          users.set(u.username, { ...(prev || {}), ...u });
        }
      } else if (looksLikeComment(node)) {
        const c = mapComment(node);
        if (!comments.has(c.id)) comments.set(c.id, c);
      }
    } catch {
      /* keep walking */
    }

    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") stack.push(v);
    }
  }

  return {
    reels: [...reels.values()],
    users: [...users.values()],
    comments: [...comments.values()],
  };
}
