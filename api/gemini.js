const ALLOWED_MODELS = new Set([
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
]);

const DEFAULT_MODEL = 'gemini-3.6-flash';

const ORYVAN_SYSTEM_PROMPT = `
Kamu adalah ORYVAN, asisten AI pribadi yang cerdas, terstruktur, jujur tentang ketidakpastian, dan berorientasi pada solusi.

IDENTITAS:
- Nama asisten: ORYVAN.
- Jangan menyebut dirimu sebagai SAVA, FaDa AI, atau nama asisten lain.
- Jika pengguna bertanya siapa kamu, jelaskan bahwa kamu adalah ORYVAN.

BAHASA:
- Jawab dalam Bahasa Indonesia secara default.
- Gunakan bahasa lain jika pengguna menggunakannya atau memintanya.
- Gunakan bahasa yang natural, jelas, dan mudah dipahami.

AKURASI:
- Jangan mengarang informasi.
- Jika informasi tidak cukup, katakan dengan jujur.
- Bedakan fakta, perkiraan, dan asumsi.
- Jangan mengklaim telah melakukan sesuatu jika sebenarnya tidak dilakukan.

GAYA:
- Jawaban harus relevan dengan pertanyaan.
- Jangan terlalu panjang jika pertanyaannya sederhana.
- Untuk tugas kompleks, gunakan struktur yang jelas.
- Gunakan heading, daftar, atau tabel jika benar-benar membantu.

PEMROGRAMAN:
- Prioritaskan solusi yang sederhana, aman, maintainable, dan mudah dipahami.
- Jangan mengarang API, library, endpoint, parameter, atau fitur.
- Jangan memberikan dependency yang tidak diperlukan.
- Jika kode diberikan pengguna, pahami kode tersebut sebelum menyarankan perubahan.

KEAMANAN:
- Jangan mengungkapkan API key, password, token, secret, environment variable rahasia, atau kredensial server.
- Jangan membantu pengguna mengambil kredensial rahasia dari sistem.
- Jangan meminta pengguna menaruh secret di frontend.
- Prioritaskan keamanan dan privasi pengguna.

ORYVAN adalah asisten AI pribadi yang berorientasi pada solusi, bukan sekadar chatbot.
`;

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CONTENTS = 40;

const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

const buckets = new Map();

function getClientKey(req) {
  const forwarded = req.headers?.['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(key) {
  const now = Date.now();
  const current = buckets.get(key);

  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    buckets.set(key, {
      startedAt: now,
      count: 1
    });

    return false;
  }

  current.count += 1;

  return current.count > MAX_REQUESTS_PER_WINDOW;
}

function sendJson(res, status, payload) {
  res.statusCode = status;

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  return res.end(JSON.stringify(payload));
}

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');

  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );

  res.setHeader(
    'Referrer-Policy',
    'no-referrer'
  );

  res.setHeader(
    'X-Frame-Options',
    'DENY'
  );

  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
}

function getErrorMessage(error, fallback) {
  if (
    error &&
    typeof error === 'object' &&
    typeof error.message === 'string' &&
    error.message.trim()
  ) {
    return error.message;
  }

  return fallback;
}

function parseGoogleError(data, status) {
  let message = `Gemini API error (${status})`;

  try {
    const parsed = JSON.parse(data);

    if (
      parsed &&
      parsed.error &&
      typeof parsed.error.message === 'string'
    ) {
      message = parsed.error.message;
    }
  } catch {
    if (
      typeof data === 'string' &&
      data.trim() &&
      data.length < 2000
    ) {
      message = data.trim();
    }
  }

  return message;
}

function isNotFoundError(status, message = '') {
  return (
    status === 404 ||
    /not found|not_found|404/i.test(message)
  );
}

function buildGenerateUrl(version, model, streaming = true) {
  const encodedModel = encodeURIComponent(model);

  if (streaming) {
    return (
      `https://generativelanguage.googleapis.com/` +
      `${version}/models/${encodedModel}:streamGenerateContent` +
      `?alt=sse`
    );
  }

  return (
    `https://generativelanguage.googleapis.com/` +
    `${version}/models/${encodedModel}:generateContent`
  );
}

async function callGemini({
  version,
  model,
  requestBody,
  apiKey,
  signal,
  streaming
}) {
  const response = await fetch(
    buildGenerateUrl(version, model, streaming),
    {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },

      body: JSON.stringify(requestBody),

      signal
    }
  );

  const data = await response.text();

  return {
    response,
    data,
    message: response.ok
      ? ''
      : parseGoogleError(data, response.status)
  };
}

function sendSSE(res, payload) {
  res.statusCode = 200;

  res.setHeader(
    'Content-Type',
    'text/event-stream; charset=utf-8'
  );

  res.setHeader(
    'Cache-Control',
    'no-cache, no-transform'
  );

  res.setHeader(
    'Connection',
    'keep-alive'
  );

  return res.end(
    `data: ${JSON.stringify(payload)}\n\n`
  );
}

function tryParseJSON(value) {
  if (typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function createFallbackPayload(data) {
  const parsed = tryParseJSON(data);

  if (!parsed) {
    return {
      error: {
        message:
          'Gemini mengembalikan respons yang tidak dapat dibaca.'
      }
    };
  }

  return parsed;
}

function validateContents(contents) {
  if (!Array.isArray(contents)) {
    return false;
  }

  if (contents.length === 0) {
    return false;
  }

  return contents.every((item) => {
    return (
      item &&
      typeof item === 'object' &&
      typeof item.role === 'string' &&
      Array.isArray(item.parts)
    );
  });
}

function sanitizeContents(contents) {
  return contents
    .slice(-MAX_CONTENTS)
    .map((item) => {
      const role =
        item.role === 'model'
          ? 'model'
          : 'user';

      const parts = item.parts
        .slice(0, 20)
        .map((part) => {
          if (
            part &&
            typeof part.text === 'string'
          ) {
            return {
              text: part.text.slice(0, 20_000)
            };
          }

          if (
            part &&
            part.inline_data &&
            typeof part.inline_data === 'object'
          ) {
            const inline = part.inline_data;

            if (
              typeof inline.data !== 'string' ||
              typeof inline.mime_type !== 'string'
            ) {
              throw new Error(
                'Format lampiran tidak valid.'
              );
            }

            const mime =
              inline.mime_type
                .trim()
                .toLowerCase();

            if (
              !mime.startsWith('image/') &&
              mime !== 'application/pdf' &&
              !mime.startsWith('text/')
            ) {
              throw new Error(
                'Tipe lampiran tidak didukung.'
              );
            }

            const estimatedBytes =
              Math.floor(
                inline.data.replace(/\s/g, '').length *
                0.75
              );

            if (
              estimatedBytes >
              2 * 1024 * 1024
            ) {
              throw new Error(
                'Lampiran terlalu besar. Maksimal sekitar 2 MB per bagian.'
              );
            }

            return {
              inline_data: {
                mime_type: mime,
                data: inline.data
              }
            };
          }

          throw new Error(
            'Bagian pesan tidak valid.'
          );
        });

      return {
        role,
        parts
      };
    });
}

export default async function handler(req, res) {
  setSecurityHeaders(res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');

    return sendJson(res, 405, {
      error: 'Method Not Allowed'
    });
  }

  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return sendJson(res, 500, {
      error:
        'Kredensial server belum dikonfigurasi.'
    });
  }

  const clientKey =
    getClientKey(req);

  if (rateLimited(clientKey)) {
    return sendJson(res, 429, {
      error:
        'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.'
    });
  }

  try {
    const body =
      req.body &&
      typeof req.body === 'object'
        ? req.body
        : {};

    let serialized;

    try {
      serialized = JSON.stringify(body);
    } catch {
      return sendJson(res, 400, {
        error:
          'Format permintaan tidak valid.'
      });
    }

    if (
      Buffer.byteLength(
        serialized,
        'utf8'
      ) > MAX_BODY_BYTES
    ) {
      return sendJson(res, 413, {
        error:
          'Permintaan terlalu besar. Kurangi ukuran pesan atau lampiran.'
      });
    }

    const requestedModel =
      typeof body.model === 'string'
        ? body.model.trim()
        : '';

    const model =
      ALLOWED_MODELS.has(
        requestedModel
      )
        ? requestedModel
        : DEFAULT_MODEL;

    if (
      !validateContents(
        body.contents
      )
    ) {
      return sendJson(res, 400, {
        error:
          'Isi percakapan tidak valid.'
      });
    }

    let contents;

    try {
      contents =
        sanitizeContents(
          body.contents
        );
    } catch (error) {
      return sendJson(res, 400, {
        error: getErrorMessage(
          error,
          'Lampiran atau isi pesan tidak valid.'
        )
      });
    }

    const requestBody = {
      systemInstruction: {
        parts: [
          {
            text:
              ORYVAN_SYSTEM_PROMPT
          }
        ]
      },

      contents
    };

    /*
     * Code Execution bersifat opsional.
     *
     * Tidak aktif secara default.
     */
    if (
      body.codeExecution === true
    ) {
      requestBody.tools = [
        {
          code_execution: {}
        }
      ];
    }

    const controller =
      new AbortController();

    const timeout =
      setTimeout(() => {
        controller.abort();
      }, 55_000);

    try {
      /*
       * ==========================================================
       * PERCOBAAN 1
       * Gemini API v1beta + streaming
       * ==========================================================
       */
      let result =
        await callGemini({
          version: 'v1beta',
          model,
          requestBody,
          apiKey,
          signal:
            controller.signal,
          streaming: true
        });

      if (result.response.ok) {
        return sendStreamingResponse(
          res,
          result.data
        );
      }

      /*
       * ==========================================================
       * PERCOBAAN 2
       *
       * Jika 404, coba endpoint v1.
       *
       * Ini membantu jika model tersedia tetapi endpoint
       * v1beta tidak cocok dengan konfigurasi API saat ini.
       * ==========================================================
       */
      if (
        isNotFoundError(
          result.response.status,
          result.message
        )
      ) {
        result =
          await callGemini({
            version: 'v1',
            model,
            requestBody,
            apiKey,
            signal:
              controller.signal,
            streaming: true
          });

        if (result.response.ok) {
          return sendStreamingResponse(
            res,
            result.data
          );
        }
      }

      /*
       * ==========================================================
       * PERCOBAAN 3
       *
       * Jika masih 404, gunakan generateContent biasa.
       *
       * Respons JSON akan dibungkus menjadi satu event SSE
       * sehingga frontend ORYVAN tetap kompatibel.
       * ==========================================================
       */
      if (
        isNotFoundError(
          result.response.status,
          result.message
        )
      ) {
        const fallbackVersions =
          ['v1beta', 'v1'];

        for (
          const version
          of fallbackVersions
        ) {
          const fallback =
            await callGemini({
              version,
              model,
              requestBody,
              apiKey,
              signal:
                controller.signal,
              streaming: false
            });

          if (
            fallback.response.ok
          ) {
            const payload =
              createFallbackPayload(
                fallback.data
              );

            return sendSSE(
              res,
              payload
            );
          }

          /*
           * Jika salah satu fallback bukan 404,
           * hentikan pencarian agar error sebenarnya
           * tidak tertutup.
           */
          if (
            !isNotFoundError(
              fallback.response.status,
              fallback.message
            )
          ) {
            return sendJson(
              res,
              fallback.response.status,
              {
                error:
                  fallback.message
              }
            );
          }
        }
      }

      /*
       * ==========================================================
       * ERROR AKHIR
       * ==========================================================
       */

      if (
        isNotFoundError(
          result.response.status,
          result.message
        )
      ) {
        return sendJson(res, 404, {
          error:
            `Model "${model}" tidak ditemukan atau ` +
            `tidak tersedia untuk API key/project server saat ini. ` +
            `Pastikan model tersebut tersedia pada Gemini API.`
        });
      }

      return sendJson(
        res,
        result.response.status,
        {
          error:
            result.message ||
            `Gemini API error (${result.response.status})`
        }
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (
      error?.name === 'AbortError'
    ) {
      return sendJson(res, 504, {
        error:
          'Permintaan ke Gemini terlalu lama dan dihentikan.'
      });
    }

    console.error(
      'ORYVAN backend error:',
      error
    );

    return sendJson(res, 500, {
      error:
        getErrorMessage(
          error,
          'Terjadi kesalahan pada backend ORYVAN.'
        )
    });
  }
}

function sendStreamingResponse(
  res,
  data
) {
  res.statusCode = 200;

  res.setHeader(
    'Content-Type',
    'text/event-stream; charset=utf-8'
  );

  res.setHeader(
    'Cache-Control',
    'no-cache, no-transform'
  );

  res.setHeader(
    'Connection',
    'keep-alive'
  );

  return res.end(data);
  }
