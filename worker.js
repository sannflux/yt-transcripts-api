/**
 * Cloudflare Worker: YouTube Transcript Fetcher v6
 *
 * Strategy:
 *  A) Try Innertube player endpoint to get captionTracks (best when allowed)
 *  B) If blocked / no tracks, fallback to /api/timedtext?type=list (often works even when player is blocked)
 *  C) Fetch captions forcing fmt=json3 when possible and parse JSON3; fallback to XML parsing
 *
 * GET /transcript?video_id=XXXXXXXXXXX&lang=en&debug=1
 */

const WORKER_VERSION = "YT_TRANSCRIPT_V6";

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
      "application/json,text/plain,text/xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Origin": "https://www.youtube.com",
    "Referer": "https://www.youtube.com/",
  };
}

/* -------------------- timedtext parsers -------------------- */

function parseTimedTextXml(xml) {
  const matches = [...String(xml).matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)];
  const chunks = matches.map((m) => m[1].replace(/<[^>]+>/g, " "));
  return normalizeText(chunks);
}

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
  if (looksLikeJson(s)) {
    const t = parseTimedTextJson3(s);
    if (t) return t;
  }
  if (s.includes("<text") && s.includes("</text>")) {
    const t = parseTimedTextXml(s);
    if (t) return t;
  }
  return "";
}

function withFmtJson3(urlStr) {
  const u = new URL(urlStr);
  u.searchParams.set("fmt", "json3");
  return u.toString();
}

/* -------------------- Method A: Innertube player -------------------- */

const INNERTUBE_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20241219.01.00",
  hl: "en",
  gl: "US",
};

async function fetchPlayer(videoId) {
  const endpoint = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
  const body = { videoId, context: { client: INNERTUBE_CLIENT } };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { ...ytHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  return { status: res.status, bodyText: text };
}

function captionTracksFromPlayer(playerObj) {
  const tracks =
    playerObj?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!Array.isArray(tracks)) return [];
  return tracks
    .map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode,
      kind: t.kind || null,
      name: t?.name?.simpleText || null,
      source: "innertube",
    }))
    .filter((t) => t.baseUrl && t.languageCode);
}

/* -------------------- Method B: api/timedtext?type=list -------------------- */

async function timedtextList(videoId) {
  const u = new URL("https://www.youtube.com/api/timedtext");
  u.searchParams.set("v", videoId);
  u.searchParams.set("type", "list");
  u.searchParams.set("hl", "en");
  u.searchParams.set("gl", "US");

  const res = await fetch(u.toString(), { headers: ytHeaders() });
  const body = await res.text();
  return { status: res.status, body };
}

function parseTrackListXml(xml) {
  const tracks = [];
  for (const m of String(xml).matchAll(/<track\b([^/>]*)\/?>/gi)) {
    const attrs = m[1] || "";
    const lang = (attrs.match(/lang_code="([^"]+)"/i) || [])[1];
    const kind = (attrs.match(/kind="([^"]+)"/i) || [])[1];
    const name = (attrs.match(/name="([^"]+)"/i) || [])[1];
    if (lang) {
      tracks.push({
        baseUrl: null, // not provided by list; we'll construct fetch using v/lang/kind
        languageCode: lang,
        kind: kind || null,
        name: name || null,
        source: "timedtext_list",
      });
    }
  }
  return tracks;
}

async function timedtextFetch(videoId, lang, kind, forceJson3 = true) {
  const u = new URL("https://www.youtube.com/api/timedtext");
  u.searchParams.set("v", videoId);
  u.searchParams.set("lang", lang);
  u.searchParams.set("hl", "en");
  u.searchParams.set("gl", "US");
  if (kind) u.searchParams.set("kind", kind);
  if (forceJson3) u.searchParams.set("fmt", "json3");

  const res = await fetch(u.toString(), { headers: ytHeaders() });
  const body = await res.text();
  return { status: res.status, body, url: u.toString(), contentType: res.headers.get("content-type") };
}

/* -------------------- Track picker -------------------- */

function pickTrack(tracks, preferredLang) {
  const p = (preferredLang || "en").toLowerCase();

  // Prefer manual (no kind)
  let t =
    tracks.find((x) => (x.languageCode || "").toLowerCase() === p && !x.kind) ||
    tracks.find((x) => (x.languageCode || "").toLowerCase().startsWith(p) && !x.kind);
  if (t) return t;

  // Then anything in preferred lang
  t =
    tracks.find((x) => (x.languageCode || "").toLowerCase() === p) ||
    tracks.find((x) => (x.languageCode || "").toLowerCase().startsWith(p));
  if (t) return t;

  // Fallback English
  t =
    tracks.find((x) => (x.languageCode || "").toLowerCase().startsWith("en") && !x.kind) ||
    tracks.find((x) => (x.languageCode || "").toLowerCase().startsWith("en"));
  if (t) return t;

  return tracks[0] || null;
}

/* -------------------- Main handler -------------------- */

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "*";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname !== "/transcript") {
      return json({ ok: false, worker_version: WORKER_VERSION, error: "not_found" }, 404, origin);
    }

    const videoId = url.searchParams.get("video_id") || "";
    const lang = url.searchParams.get("lang") || "en";
    const debug = url.searchParams.get("debug") === "1";

    if (!isValidVideoId(videoId)) {
      return json(
        { ok: false, worker_version: WORKER_VERSION, error: "bad_request", detail: "Invalid video_id", video_id: videoId },
        400,
        origin
      );
    }

    const logs = [];
    const log = (obj) => debug && logs.push(obj);

    try {
      // ---------- A) Innertube ----------
      const playerRes = await fetchPlayer(videoId);
      log({ method: "player_post", status: playerRes.status, head: playerRes.bodyText.slice(0, 220) });

      let playabilityStatus = null;
      let playabilityReason = null;
      let tracksA = [];

      if (playerRes.status === 200 && !looksLikeHtml(playerRes.bodyText)) {
        try {
          const playerObj = JSON.parse(playerRes.bodyText);
          playabilityStatus = playerObj?.playabilityStatus?.status || null;
          playabilityReason = playerObj?.playabilityStatus?.reason || null;
          log({ method: "playability", status: playabilityStatus, reason: playabilityReason });

          tracksA = captionTracksFromPlayer(playerObj);
          log({ method: "captionTracks_from_player", count: tracksA.length, sample: tracksA[0] || null });
        } catch (e) {
          log({ method: "player_json_parse_failed", detail: String(e) });
        }
      } else {
        log({ method: "player_unusable", note: "non-200 or returned HTML" });
      }

      if (tracksA.length) {
        const chosen = pickTrack(tracksA, lang);
        log({ method: "chosen_track", source: chosen.source, chosen });

        const capUrl = withFmtJson3(chosen.baseUrl);
        log({ method: "caption_fetch_url", source: "innertube", head: capUrl.slice(0, 180) + "..." });

        const capRes = await fetch(capUrl, { headers: ytHeaders() });
        const capBody = await capRes.text();
        log({
          method: "caption_fetch",
          source: "innertube",
          status: capRes.status,
          contentType: capRes.headers.get("content-type"),
          head: capBody.slice(0, 260),
        });

        if (capRes.status === 200 && !looksLikeHtml(capBody)) {
          const transcript = parseTimedTextAuto(capBody);
          if (transcript && transcript.length >= 20) {
            return json(
              {
                ok: true,
                worker_version: WORKER_VERSION,
                video_id: videoId,
                lang: chosen.languageCode,
                kind: chosen.kind,
                length: transcript.length,
                text: transcript,
                via: "innertube",
                logs,
              },
              200,
              origin
            );
          }
        }
        log({ method: "innertube_caption_parse_failed" });
      }

      // ---------- B) timedtext list fallback ----------
      const listRes = await timedtextList(videoId);
      log({ method: "timedtext_list", status: listRes.status, head: listRes.body.slice(0, 240) });

      if (listRes.status !== 200 || !listRes.body.includes("<transcript_list")) {
        return json(
          {
            ok: false,
            worker_version: WORKER_VERSION,
            video_id: videoId,
            error: "blocked_or_unavailable",
            detail:
              playabilityStatus === "LOGIN_REQUIRED"
                ? "YouTube bot-check/login required from this IP. Try later or use upload/paste fallback."
                : `Timedtext list unavailable (status=${listRes.status}).`,
            playability: playabilityStatus,
            reason: playabilityReason,
            logs,
          },
          502,
          origin
        );
      }

      const tracksB = parseTrackListXml(listRes.body);
      log({ method: "timedtext_tracks_parsed", count: tracksB.length, sample: tracksB[0] || null });

      if (!tracksB.length) {
        return json(
          {
            ok: false,
            worker_version: WORKER_VERSION,
            video_id: videoId,
            error: "no_tracks",
            detail: "No caption tracks available from timedtext list.",
            logs,
          },
          404,
          origin
        );
      }

      const chosenB = pickTrack(tracksB, lang);
      log({ method: "chosen_track", source: chosenB.source, chosen: chosenB });

      // Try JSON3 first
      const capB = await timedtextFetch(videoId, chosenB.languageCode, chosenB.kind, true);
      log({
        method: "timedtext_fetch",
        status: capB.status,
        url_head: capB.url.slice(0, 160) + "...",
        contentType: capB.contentType,
        head: capB.body.slice(0, 260),
      });

      if (capB.status === 200 && !looksLikeHtml(capB.body)) {
        let transcriptB = parseTimedTextAuto(capB.body);

        // Fallback to XML if JSON3 empty
        if (!transcriptB || transcriptB.length < 20) {
          const capB2 = await timedtextFetch(videoId, chosenB.languageCode, chosenB.kind, false);
          log({
            method: "timedtext_fetch_fallback_xml",
            status: capB2.status,
            contentType: capB2.contentType,
            head: capB2.body.slice(0, 260),
          });
          if (capB2.status === 200 && !looksLikeHtml(capB2.body)) {
            transcriptB = parseTimedTextAuto(capB2.body);
          }
        }

        if (transcriptB && transcriptB.length >= 20) {
          return json(
            {
              ok: true,
              worker_version: WORKER_VERSION,
              video_id: videoId,
              lang: chosenB.languageCode,
              kind: chosenB.kind,
              length: transcriptB.length,
              text: transcriptB,
              via: "timedtext_list",
              logs,
            },
            200,
            origin
          );
        }
      }

      return json(
        {
          ok: false,
          worker_version: WORKER_VERSION,
          video_id: videoId,
          error: "empty_transcript",
          detail: "Caption track exists but transcript could not be fetched/parsed (blocked or unsupported format).",
          playability: playabilityStatus,
          reason: playabilityReason,
          logs,
        },
        404,
        origin
      );
    } catch (e) {
      return json(
        {
          ok: false,
          worker_version: WORKER_VERSION,
          video_id: videoId,
          error: "internal_error",
          detail: String(e?.message || e),
          logs,
        },
        500,
        origin
      );
    }
  },
};
