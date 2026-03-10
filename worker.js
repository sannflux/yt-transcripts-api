/**
 * Cloudflare Worker: YouTube Transcript Fetcher v5 (Innertube)
 *
 * GET /transcript?video_id=XXXXXXXXXXX&lang=en&debug=1
 *
 * Uses youtubei/v1/player to obtain captionTracks reliably (no HTML scraping).
 * Then fetches the caption baseUrl (forces fmt=json3) and parses JSON3.
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
  const t = String(s || "").slice(0, 400).toLowerCase();
  return t.includes("<!doctype html") || t.includes("<html") || t.includes("consent.youtube.com");
}
function ytHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Origin": "https://www.youtube.com",
    "Referer": "https://www.youtube.com/",
  };
}

// ---- JSON3 timedtext parse ----
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

function withFmtJson3(baseUrl) {
  const u = new URL(baseUrl);
  u.searchParams.set("fmt", "json3");
  return u.toString();
}

// ---- Innertube player call ----
// This client config is commonly used for unauthenticated access.
// It may change over time; if it breaks, we adjust clientVersion.
const INNERTUBE_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20241219.01.00",
  hl: "en",
  gl: "US",
};

async function fetchPlayer(videoId) {
  const endpoint = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
  const body = {
    videoId,
    context: { client: INNERTUBE_CLIENT },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...ytHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  return { status: res.status, bodyText: text };
}

function extractCaptionTracksFromPlayer(playerObj) {
  const tracks =
    playerObj?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!Array.isArray(tracks)) return [];
  return tracks
    .map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      kind: t.kind || null,
      name: t?.name?.simpleText || null,
    }))
    .filter((t) => t.baseUrl && t.languageCode);
}

function pickTrack(tracks, preferredLang) {
  const p = (preferredLang || "en").toLowerCase();

  // Prefer manual (no kind)
  let t =
    tracks.find((x) => (x.languageCode || "").toLowerCase() === p && !x.kind) ||
    tracks.find((x) => (x.languageCode || "").toLowerCase().startsWith(p) && !x.kind);
  if (t) return t;

  // then any
  t =
    tracks.find((x) => (x.languageCode || "").toLowerCase() === p) ||
    tracks.find((x) => (x.languageCode || "").toLowerCase().startsWith(p));
  if (t) return t;

  // fallback English
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
    const debug = url.searchParams.get("debug") === "1";

    if (!isValidVideoId(videoId)) {
      return json(
        { ok: false, error: "bad_request", detail: "Invalid video_id", video_id: videoId },
        400,
        origin
      );
    }

    const logs = [];
    const log = (obj) => debug && logs.push(obj);

    try {
      const playerRes = await fetchPlayer(videoId);
      log({ method: "player_post", status: playerRes.status, head: playerRes.bodyText.slice(0, 220) });

      if (playerRes.status !== 200) {
        return json(
          { ok: false, video_id: videoId, error: "player_fetch_failed", detail: `status=${playerRes.status}`, logs },
          502,
          origin
        );
      }
      if (looksLikeHtml(playerRes.bodyText)) {
        return json(
          { ok: false, video_id: videoId, error: "player_returned_html", detail: "Player endpoint returned HTML", logs },
          502,
          origin
        );
      }

      let playerObj;
      try {
        playerObj = JSON.parse(playerRes.bodyText);
      } catch (e) {
        return json(
          { ok: false, video_id: videoId, error: "player_json_parse_failed", detail: String(e), logs },
          502,
          origin
        );
      }

      // Sometimes status is "LOGIN_REQUIRED" or similar
      const playStatus = playerObj?.playabilityStatus?.status;
      log({ method: "playability", status: playStatus, reason: playerObj?.playabilityStatus?.reason || null });

      const tracks = extractCaptionTracksFromPlayer(playerObj);
      log({ method: "captionTracks_from_player", count: tracks.length, sample: tracks[0] || null });

      if (!tracks.length) {
        return json(
          {
            ok: false,
            video_id: videoId,
            error: "no_caption_tracks",
            detail: "No captionTracks available from player endpoint (video may have CC but restricted to logged-in or other client)",
            logs,
          },
          404,
          origin
        );
      }

      const chosen = pickTrack(tracks, lang);
      log({ method: "chosen_track", chosen });

      const capUrl = withFmtJson3(chosen.baseUrl);
      log({ method: "caption_fetch_url", head: capUrl.slice(0, 180) + "..." });

      const capRes = await fetch(capUrl, { headers: ytHeaders() });
      const capText = await capRes.text();
      log({
        method: "caption_fetch",
        status: capRes.status,
        contentType: capRes.headers.get("content-type"),
        head: capText.slice(0, 260),
      });

      if (capRes.status !== 200) {
        return json(
          { ok: false, video_id: videoId, error: "caption_fetch_failed", detail: `status=${capRes.status}`, logs },
          502,
          origin
        );
      }
      if (looksLikeHtml(capText)) {
        return json(
          { ok: false, video_id: videoId, error: "caption_fetch_returned_html", detail: "Caption fetch returned HTML", logs },
          502,
          origin
        );
      }

      const transcript = parseTimedTextJson3(capText);
      if (!transcript || transcript.length < 20) {
        return json(
          { ok: false, video_id: videoId, error: "empty_transcript", detail: "Parsed transcript empty/too short", logs },
          404,
          origin
        );
      }

      return json(
        {
          ok: true,
          video_id: videoId,
          lang: chosen.languageCode,
          kind: chosen.kind,
          length: transcript.length,
          text: transcript,
          logs,
        },
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
