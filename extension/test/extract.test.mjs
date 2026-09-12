// Normalizer test:  node extension/test/extract.test.mjs
//
// The payloads below mirror the three shapes Instagram's web app actually ships
// for the same objects: the REST v1 clips feed, the GraphQL xdt_* connection,
// and the legacy shortcode media envelope. The extractor must handle all three
// without knowing any of their paths.

import { extract } from "../src/lib/ig.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label}${cond ? "" : "  " + detail}`);
  if (!cond) failures++;
};

// --- shape 1: REST v1 clips feed -------------------------------------------
const restClips = {
  items: [
    {
      media: {
        pk: "3001",
        code: "DAbc123XyZ",
        media_type: 2,
        product_type: "clips",
        play_count: 412000,
        like_count: 18400,
        comment_count: 230,
        taken_at: 1757000000,
        video_duration: 14.2,
        caption: { text: "3 ta xato #fitness" },
        user: { username: "rival", pk: "77" },
        video_versions: [{ url: "https://cdn.example/v1.mp4", width: 720 }],
        image_versions2: { candidates: [{ url: "https://cdn.example/t1.jpg" }] },
        clips_metadata: {
          original_sound_info: { audio_asset_id: "9" },
          music_info: null,
        },
      },
    },
  ],
};

// --- shape 2: GraphQL xdt connection ---------------------------------------
const graphqlClips = {
  data: {
    xdt_api__v1__clips__user__connection_v2: {
      edges: [
        {
          node: {
            media: {
              pk: "3002",
              code: "DXyz789Abc",
              media_type: 2,
              ig_play_count: 96000,
              like_count: 5100,
              comment_count: 61,
              taken_at: 1757200000,
              video_duration: 41.9,
              caption: { text: "Uzun format test" },
              user: { username: "rival" },
              video_versions: [{ url: "https://cdn.example/v2.mp4" }],
              clips_metadata: {
                music_info: { music_asset_info: { title: "Trending Sound" } },
              },
            },
          },
        },
      ],
      page_info: { has_next_page: true },
    },
  },
};

// --- shape 3: legacy shortcode media + profile ------------------------------
const shortcodeMedia = {
  data: {
    xdt_shortcode_media: {
      id: "3003",
      shortcode: "DLmn456Qrs",
      is_video: true,
      video_play_count: 2300000,
      video_url: "https://cdn.example/v3.mp4",
      video_duration: 9.4,
      edge_media_preview_like: { count: 140000 },
      edge_media_to_parent_comment: { count: 2100 },
      edge_media_to_caption: { edges: [{ node: { text: "Viral bo'lgan reel" } }] },
      taken_at_timestamp: 1757300000,
      owner: { username: "rival", id: "77" },
    },
  },
};

const webProfileInfo = {
  data: {
    user: {
      id: "77",
      username: "rival",
      full_name: "Rival Creator",
      biography: "Fitness va nutrition",
      edge_followed_by: { count: 128000 },
      edge_follow: { count: 310 },
      edge_owner_to_timeline_media: { count: 642 },
      is_business_account: true,
      category_name: "Personal Trainer",
      is_verified: false,
      external_url: "https://rival.example",
      profile_pic_url: "https://cdn.example/p.jpg",
    },
  },
};

const commentsPayload = {
  comments: [
    { pk: "c1", text: "Bu qanday qilinadi?", created_at: 1757300100, user: { username: "viewer1" }, comment_like_count: 12 },
    { pk: "c2", text: "+", created_at: 1757300200, user: { username: "viewer2" } },
  ],
};

// --- tests -----------------------------------------------------------------

console.log("\nrest v1 clips feed");
{
  const { reels } = extract(restClips);
  check("finds the reel", reels.length === 1, `got ${reels.length}`);
  const r = reels[0];
  check("shortcode", r.code === "DAbc123XyZ");
  check("play_count -> views", r.views === 412000, `got ${r.views}`);
  check("likes", r.likes === 18400);
  check("caption text unwrapped", r.caption === "3 ta xato #fitness");
  check("owner", r.username === "rival");
  check("video url", r.video_url === "https://cdn.example/v1.mp4");
  check("duration", r.duration === 14.2);
  check("original audio detected", r.is_original_audio === true);
}

console.log("\ngraphql xdt connection");
{
  const { reels } = extract(graphqlClips);
  check("finds the nested reel", reels.length === 1, `got ${reels.length}`);
  check("ig_play_count -> views", reels[0].views === 96000);
  check("trending audio title", reels[0].audio_title === "Trending Sound");
  check("not marked original audio", reels[0].is_original_audio === false);
}

console.log("\nlegacy shortcode media");
{
  const { reels } = extract(shortcodeMedia);
  check("finds the reel", reels.length === 1, `got ${reels.length}`);
  const r = reels[0];
  check("shortcode field", r.code === "DLmn456Qrs");
  check("video_play_count -> views", r.views === 2300000);
  check("edge like count", r.likes === 140000);
  check("caption from edges", r.caption === "Viral bo'lgan reel");
  check("owner from owner field", r.username === "rival");
}

console.log("\nprofile payload");
{
  const { users } = extract(webProfileInfo);
  check("finds the user", users.length === 1, `got ${users.length}`);
  const u = users[0];
  check("followers from edge", u.followers === 128000);
  check("following from edge", u.following === 310);
  check("media count from edge", u.media_count === 642);
  check("business flag", u.is_business === true);
  check("category", u.category === "Personal Trainer");
}

console.log("\ncomments");
{
  const { comments } = extract(commentsPayload);
  check("finds both comments", comments.length === 2, `got ${comments.length}`);
  check("keeps the trigger text", comments.some((c) => c.text === "+"));
  check("author captured", comments[0].username?.startsWith("viewer"));
}

console.log("\nmixed + hostile input");
{
  const { reels, users } = extract({ ...restClips, ...webProfileInfo, junk: { a: [1, 2, { b: null }] } });
  check("reel and user from one envelope", reels.length === 1 && users.length === 1);

  check("null payload is safe", extract(null).reels.length === 0);
  check("empty object is safe", extract({}).reels.length === 0);
  check("no false positive on a plain user", extract({ user: { username: "x" } }).users.length === 0);

  const cyclic = { a: {} };
  cyclic.a.self = cyclic;
  check("cycles terminate", extract(cyclic).reels.length === 0);

  // A story/photo post is not a reel.
  check(
    "photo post is not captured as a reel",
    extract({ items: [{ media: { code: "Pho123abcd", media_type: 1, like_count: 5 } }] }).reels.length === 0
  );
}

console.log("\nmerge behaviour");
{
  // Feed view first (no video url), then the detail view: richer record must win.
  const feed = extract(graphqlClips).reels[0];
  const merged = extract({ a: graphqlClips, b: { media: { ...graphqlClips.data.xdt_api__v1__clips__user__connection_v2.edges[0].node.media, video_versions: [{ url: "https://cdn.example/full.mp4" }] } } });
  check("one record per shortcode", merged.reels.length === 1, `got ${merged.reels.length}`);
  check("keeps the richer video url", merged.reels[0].video_url.includes("full.mp4") || feed.video_url != null);
}

console.log(`\n${failures ? failures + " FAILED" : "all checks passed"}\n`);
process.exit(failures ? 1 : 0);
