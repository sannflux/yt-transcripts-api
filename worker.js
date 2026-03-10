/**
 * Cloudflare Worker: YouTube Transcript Fetcher (robust v3)
 * - Uses watch HTML -> captionTracks -> baseUrl
 * - Parses timedtext in XML OR JSON3
 *
 * GET /transcript?video_id=XXXXXXXXXXX&lang=en&debug=1
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
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
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

function looksLikeHtml(s) {
  const t = String(s || "").slice(0, 500).toLowerCase();
  return t.includes("<!doctype html") || t.includes("<html") || t.includes("consent.youtube.com");
}

function looksLikeJson(s) {
  const t = String(s || "").trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

function ytHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,text/xml;q=0.8,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
  };
}

// ---------- Parser: timedtext XML ----------
function parseTimedTextXml(xml) {
  const matches = [...String(xml).matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)];
  const chunks = matches.map((m) => m[1].replace(/<[^>]+>/g, " "));
  return normalizeText(chunks);
}

// ---------- Parser: timedtext JSON3 ----------
function parseTimedTextJson3(jsonText) {
  try {
    const obj = JSON.parse(jsonText);
    const chunks = [];
    const events = obj?.events || [];
    for (const ev of events) {
      const segs = ev?.segs || [];
      for (const seg of segs) {
        const t = seg?.utf8;
        if (t) chunks.push(t);
      }
    }
    return normalizeText(chunks);
  } catch {
    return "";
  }
}

function parseTimedTextAuto(bodyText) {
  const s = String(bodyText || "");
  if (!s.trim()) return "";

  // JSON3
  if (looksLikeJson(s)) {
    const t = parseTimedTextJson3(s);
    if (t) return t;
  }

  // XML
  if (s.includes("<text") && s.includes("</text>")) {
    const t = parseTimedTextXml(s);
    if (t) return t;
  }

  // Some responses might be XML transcript with no <text> nodes
  return "";
}

// ---------- Method: watch HTML -> captionTracks ----------
async function fetchWatchHtml(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`;
  const res = await fetch(url, { headers: ytHeaders() });
  return { status: res.status, body: await res.text() };
}

function extractCaptionTracksFromWatchHtml(htmlText) {
  const s = String(htmlText || "");
  const idx = s.indexOf('"captionTracks":');
  if (idx === -1) return [];

  const start = s.indexOf("[", idx);
  if (start === -1) return [];

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
    const fixed = arrText
      .replace(/\\u0026/g, "&")
      .replace(/\\u003d/g, "=")
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">");

    const arr = JSON.parse(fixed);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        kind: t.kind || null,
        name: t?.name?.simpleText || null,
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

// ---------- Endpoint ----------
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
    const debug = url.searchParams.get("debug") === "1";

    if (!isValidVideoId(videoId)) {
      return json(
        { ok: false, error: "bad_request", detail: "Invalid video_id", video_id: videoId },
        400,
        origin
      );
    }

    const logs = [];
    const log = (obj) => {
      if (debug) logs.push(obj);
    };

    try {
      const watchRes = await fetchWatchHtml(videoId);
      log({ method: "watch_html", status: watchRes.status, head: watchRes.body.slice(0, 160) });

      if (watchRes.status !== 200) {
        return json(
          { ok: false, video_id: videoId, error: "watch_fetch_failed", detail: `status=${watchRes.status}`, logs },
          502,
          origin
        );
      }

      if (watchRes.body.toLowerCase().includes("consent.youtube.com")) {
        return json(
          {
            ok: false,
            video_id: videoId,
            error: "consent_interstitial",
            detail: "YouTube returned a consent page from Cloudflare IP.",
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
            detail: "Could not find captionTracks on watch page (video may have no captions or is restricted).",
            logs,
          },
          404,
          origin
        );
      }

      const chosen = pickCaptionTrack(capTracks, lang);
      log({ method: "captionTracks_chosen", chosen });

      const capRes = await fetch(chosen.baseUrl, { headers: ytHeaders() });
      const capBody = await capRes.text();

      log({
        method: "caption_baseUrl_fetch",
        status: capRes.status,
        contentType: capRes.headers.get("content-type"),
        head: capBody.slice(0, 220),
      });

      if (capRes.status !== 200) {
        return json(
          { ok: false, video_id: videoId, error: "caption_fetch_failed", detail: `status=${capRes.status}`, logs },
          502,
          origin
        );
      }

      if (looksLikeHtml(capBody)) {
        return json(
          {
            ok: false,
            video_id: videoId,
            error: "caption_fetch_returned_html",
            detail: "Caption baseUrl returned HTML (likely blocked).",
            logs,
          },
          502,
          origin
        );
      }

      const text = parseTimedTextAuto(capBody);
      if (!text || text.length < 20) {
        return json(
          {
            ok: false,
            video_id: videoId,
            error: "empty_transcript",
            detail: "Parsed transcript empty/too short",
            logs,
          },
          404,
          origin
        );
      }

      return json(
        { ok: true, video_id: videoId, lang: chosen.languageCode, kind: chosen.kind, length: text.length, text, logs },
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
