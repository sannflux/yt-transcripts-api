/**
 * Cloudflare Worker: YouTube Transcript Fetcher (best-effort)
 * Endpoint:
 *   GET /transcript?video_id=XXXXXXXXXXX&lang=en
 *
 * Returns JSON:
 *   { ok: true, video_id, lang, text }
 *   { ok: false, video_id, error, detail }
 */

function corsHeaders(origin) {
  // If you want to lock this down later, replace * with your Streamlit domain.
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(obj, status = 200, origin = "*") {
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

function normalizeText(chunks) {
  const text = chunks
    .filter(Boolean)
    .map(s => String(s).trim())
    .filter(s => s.length)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function parseTimedTextXml(xml) {
  // YouTube timedtext XML: <transcript><text start="..." dur="...">hello</text>...
  // We'll extract inner text of <text> nodes.
  const matches = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)];
  const chunks = matches.map(m =>
    m[1]
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
  );
  return normalizeText(chunks);
}

async function fetchTimedTextXml(videoId, lang, kind) {
  const url = new URL("https://www.youtube.com/api/timedtext");
  url.searchParams.set("v", videoId);
  url.searchParams.set("lang", lang);
  if (kind) url.searchParams.set("kind", kind);

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/xml,text/plain,*/*",
    },
  });

  const text = await res.text();
  return { status: res.status, body: text };
}

async function fetchTrackList(videoId) {
  const url = new URL("https://www.youtube.com/api/timedtext");
  url.searchParams.set("v", videoId);
  url.searchParams.set("type", "list");

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/xml,text/plain,*/*",
    },
  });

  const body = await res.text();
  return { status: res.status, body };
}

function parseTrackList(xml) {
  // Extract <track ... /> attributes
  const tracks = [];
  for (const m of xml.matchAll(/<track\b([^/>]*)\/?>/gi)) {
    const attrs = m[1] || "";
    const lang = (attrs.match(/lang_code="([^"]+)"/i) || [])[1];
    const kind = (attrs.match(/kind="([^"]+)"/i) || [])[1];
    if (lang) tracks.push({ lang, kind: kind || null });
  }
  return tracks;
}

function pickTrack(tracks, preferredLang) {
  // Prefer exact preferredLang, then en, then any.
  const p = preferredLang?.toLowerCase() || "en";
  const exact = tracks.find(t => (t.lang || "").toLowerCase() === p && !t.kind);
  if (exact) return exact;

  const enManual = tracks.find(t => (t.lang || "").toLowerCase().startsWith("en") && !t.kind);
  if (enManual) return enManual;

  const enAny = tracks.find(t => (t.lang || "").toLowerCase().startsWith("en"));
  if (enAny) return enAny;

  return tracks[0] || null;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/transcript") {
      return jsonResponse({ ok: false, error: "not_found" }, 404, origin);
    }

    const videoId = url.searchParams.get("video_id") || "";
    const lang = url.searchParams.get("lang") || "en";

    if (!isValidVideoId(videoId)) {
      return jsonResponse({ ok: false, error: "bad_request", detail: "Invalid video_id" }, 400, origin);
    }

    try {
      // Step 1: list tracks
      const listRes = await fetchTrackList(videoId);
      if (listRes.status !== 200 || !listRes.body.includes("<transcript_list")) {
        return jsonResponse(
          {
            ok: false,
            video_id: videoId,
            error: "blocked_or_unavailable",
            detail: `Track list fetch failed (status=${listRes.status})`,
          },
          502,
          origin
        );
      }

      const tracks = parseTrackList(listRes.body);
      if (!tracks.length) {
        return jsonResponse(
          { ok: false, video_id: videoId, error: "no_tracks", detail: "No caption tracks available" },
          404,
          origin
        );
      }

      const chosen = pickTrack(tracks, lang);
      if (!chosen) {
        return jsonResponse(
          { ok: false, video_id: videoId, error: "no_track_selected" },
          404,
          origin
        );
      }

      // Step 2: fetch timedtext xml
      const capRes = await fetchTimedTextXml(videoId, chosen.lang, chosen.kind);
      if (capRes.status !== 200 || !capRes.body) {
        return jsonResponse(
          {
            ok: false,
            video_id: videoId,
            error: "caption_fetch_failed",
            detail: `Caption fetch failed (status=${capRes.status})`,
          },
          502,
          origin
        );
      }

      const transcriptText = parseTimedTextXml(capRes.body);
      if (!transcriptText || transcriptText.length < 20) {
        return jsonResponse(
          {
            ok: false,
            video_id: videoId,
            error: "empty_transcript",
            detail: "Transcript parsed but empty/too short",
          },
          404,
          origin
        );
      }

      return jsonResponse(
        { ok: true, video_id: videoId, lang: chosen.lang, text: transcriptText },
        200,
        origin
      );
    } catch (e) {
      return jsonResponse(
        { ok: false, video_id: videoId, error: "internal_error", detail: String(e?.message || e) },
        500,
        origin
      );
    }
  },
};

