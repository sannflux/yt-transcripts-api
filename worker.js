/**
 * Cloudflare Worker: YouTube Transcript Fetcher (robust)
 * GET /transcript?video_id=XXXXXXXXXXX&lang=en
 */

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
function json(obj, status = 200, origin = "*") {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
      "Cache-Control": "no-store",
    },
  });
}
function isValidVideoId(id) {
  return typeof id === "string" && /^[0-9A-Za-z_-]{11}$/.test(id);
}
function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
function normalizeText(chunks) {
  return chunks
    .filter(Boolean)
    .map((x) => decodeHtml(x).trim())
    .filter((x) => x.length)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
function parseTimedTextXml(xml) {
  const matches = [...String(xml).matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)];
  const chunks = matches.map((m) => m[1].replace(/<[^>]+>/g, " "));
  return normalizeText(chunks);
}

function looksLikeHtml(s) {
  const t = String(s || "").slice(0, 400).toLowerCase();
  return t.includes("<!doctype html") || t.includes("<html") || t.includes("consent.youtube.com");
}

function ytHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
  };
}

// --- Method A: timedtext type=list (sometimes works) ---
async function timedtextList(videoId) {
  const url = new URL("https://www.youtube.com/api/timedtext");
  url.searchParams.set("v", videoId);
  url.searchParams.set("type", "list");
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "US");
  const res = await fetch(url.toString(), { headers: ytHeaders() });
  return { status: res.status, body: await res.text() };
}

function parseTrackList(xml) {
  const tracks = [];
  for (const m of String(xml).matchAll(/<track\b([^/>]*)\/?>/gi)) {
    const attrs = m[1] || "";
    const lang = (attrs.match(/lang_code="([^"]+)"/i) || [])[1];
    const kind = (attrs.match(/kind="([^"]+)"/i) || [])[1];
    const name = (attrs.match(/name="([^"]+)"/i) || [])[1];
    if (lang) tracks.push({ lang, kind: kind || null, name: name || null });
  }
  return tracks;
}

function pickTrack(tracks, preferredLang) {
  const p = (preferredLang || "en").toLowerCase();

  let t =
    tracks.find((x) => (x.lang || "").toLowerCase() === p && !x.kind) ||
    tracks.find((x) => (x.lang || "").toLowerCase().startsWith(p) && !x.kind);
  if (t) return t;

  t =
    tracks.find((x) => (x.lang || "").toLowerCase() === p) ||
    tracks.find((x) => (x.lang || "").toLowerCase().startsWith(p));
  if (t) return t;

  t =
    tracks.find((x) => (x.lang || "").toLowerCase().startsWith("en") && !x.kind) ||
    tracks.find((x) => (x.lang || "").toLowerCase().startsWith("en"));
  if (t) return t;

  return tracks[0] || null;
}

async function timedtextFetch(videoId, lang, kind) {
  const url = new URL("https://www.youtube.com/api/timedtext");
  url.searchParams.set("v", videoId);
  url.searchParams.set("lang", lang);
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "US");
  if (kind) url.searchParams.set("kind", kind);

  const res = await fetch(url.toString(), { headers: ytHeaders() });
  return { status: res.status, body: await res.text() };
}

// --- Method B: scrape watch HTML, extract captionTracks ---
async function fetchWatchHtml(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`;
  const res = await fetch(url, { headers: ytHeaders() });
  return { status: res.status, body: await res.text() };
}

function extractCaptionTracksFromWatchHtml(htmlText) {
  // Look for: "captionTracks":[{...,"baseUrl":"..."}]
  const s = String(htmlText || "");
  const idx = s.indexOf('"captionTracks":');
  if (idx === -1) return [];

  // Find the JSON array that starts after "captionTracks":
  const start = s.indexOf("[", idx);
  if (start === -1) return [];

  // naive bracket matching to get the array substring
  let depth = 0;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return [];

  const arrText = s.slice(start, end);

  try {
    // captionTracks JSON is valid JSON (double quotes), but may contain \u0026 etc.
    const fixed = arrText.replace(/\\u0026/g, "&");
    const arr = JSON.parse(fixed);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        kind: t.kind || null,
        name: t?.name?.simpleText || null,
        isTranslatable: !!t.isTranslatable,
      }))
      .filter((t) => t.baseUrl && t.languageCode);
  } catch {
    return [];
  }
}

function pickCaptionTrack(tracks, preferredLang) {
  const p = (preferredLang || "en").toLowerCase();

  let t =
    tracks.find((x) => (x.languageCode || "").toLowerCase() === p && !x.kind) ||
    tracks.find((x) => (x.languageCode || "").toLowerCase().startsWith(p) && !x.kind);
  if (t) return t;

  t =
    tracks.find((x) => (x.languageCode || "").toLowerCase() === p) ||
    tracks.find((x) => (x.languageCode || "").toLowerCase().startsWith(p));
  if (t) return t;

  t =
    tracks.find((x) => (x.languageCode || "").toLowerCase().startsWith("en") && !x.kind) ||
    tracks.find((x) => (x.languageCode || "").toLowerCase().startsWith("en"));
  if (t) return t;

  return tracks[0] || null;
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/transcript") {
      return json({ ok: false, error: "not_found" }, 404, origin);
    }

    const videoId = url.searchParams.get("video_id") || "";
    const lang = url.searchParams.get("lang") || "en";

    if (!isValidVideoId(videoId)) {
      return json(
        { ok: false, error: "bad_request", detail: "Invalid video_id", video_id: videoId },
        400,
        origin
      );
    }

    const debug = url.searchParams.get("debug") === "1";
    const logs = [];
    const log = (x) => debug && logs.push(x);

    try {
      // Try Method A
      const listRes = await timedtextList(videoId);
      log({ method: "timedtext_list", status: listRes.status, head: listRes.body.slice(0, 120) });

      if (listRes.status === 200 && listRes.body.includes("<transcript_list")) {
        const tracks = parseTrackList(listRes.body);
        log({ method: "timedtext_list_parsed", tracks: tracks.slice(0, 10) });

        if (tracks.length) {
          const chosen = pickTrack(tracks, lang);
          const capRes = await timedtextFetch(videoId, chosen.lang, chosen.kind);
          log({ method: "timedtext_fetch", status: capRes.status, head: capRes.body.slice(0, 120) });

          const text = parseTimedTextXml(capRes.body);
          if (text && text.length >= 20) {
            return json(
              { ok: true, video_id: videoId, lang: chosen.lang, kind: chosen.kind, length: text.length, text, logs },
              200,
              origin
            );
          }
        }
      } else {
        // If we got HTML or consent page, fall through to Method B
        if (looksLikeHtml(listRes.body)) {
          log({ note: "timedtext_list_returned_html" });
        }
      }

      // Method B: watch HTML scrape for captionTracks
      const watchRes = await fetchWatchHtml(videoId);
      log({ method: "watch_html", status: watchRes.status, head: watchRes.body.slice(0, 120) });

      if (watchRes.status !== 200 || looksLikeHtml(watchRes.body) === false) {
        // It's still "html", but we check consent by content below anyway.
      }

      if (watchRes.body.toLowerCase().includes("consent.youtube.com")) {
        return json(
          {
            ok: false,
            video_id: videoId,
            error: "consent_interstitial",
            detail: "YouTube returned a consent page. Try again later or use another region/account-free video.",
            logs,
          },
          502,
          origin
        );
      }

      const capTracks = extractCaptionTracksFromWatchHtml(watchRes.body);
      log({ method: "captionTracks_extracted", count: capTracks.length, sample: capTracks[0] || null });

      if (!capTracks.length) {
        return json(
          {
            ok: false,
            video_id: videoId,
            error: "no_caption_tracks",
            detail: "Could not find captionTracks on watch page (video may have no captions or page is restricted).",
            logs,
          },
          404,
          origin
        );
      }

      const chosen2 = pickCaptionTrack(capTracks, lang);
      log({ method: "captionTracks_chosen", chosen: chosen2 });

      // Fetch chosen baseUrl (it returns timedtext XML typically)
      const capRes2 = await fetch(chosen2.baseUrl, { headers: ytHeaders() });
      const body2 = await capRes2.text();
      log({ method: "caption_baseUrl_fetch", status: capRes2.status, head: body2.slice(0, 120) });

      if (capRes2.status !== 200) {
        return json(
          { ok: false, video_id: videoId, error: "caption_baseurl_fetch_failed", detail: `status=${capRes2.status}`, logs },
          502,
          origin
        );
      }

      const text2 = parseTimedTextXml(body2);
      if (!text2 || text2.length < 20) {
        return json(
          { ok: false, video_id: videoId, error: "empty_transcript", detail: "Parsed transcript empty/too short", logs },
          404,
          origin
        );
      }

      return json(
        { ok: true, video_id: videoId, lang: chosen2.languageCode, kind: chosen2.kind, length: text2.length, text: text2, logs },
        200,
        origin
      );
    } catch (e) {
      return json(
        { ok: false, video_id: videoId, error: "internal_error", detail: String(e?.message || e), logs },
        500,
        origin
      );
    }
  },
};
