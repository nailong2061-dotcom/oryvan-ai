const ALLOWED_MODELS = new Set([
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite'
]);

const DEFAULT_MODEL = 'gemini-3.6-flash';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CONTENTS = 40;
const MAX_PARTS_PER_MESSAGE = 20;
const MAX_TEXT_LENGTH = 20_000;

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

const REQUEST_TIMEOUT_MS = 55_000;

const buckets = new Map();

const ORYVAN_SYSTEM_PROMPT = `
Kamu adalah ORYVAN, asisten AI pribadi yang cerdas, akurat,
terstruktur, jujur, dan berorientasi pada solusi.

IDENTITAS:
- Nama kamu adalah ORYVAN.
- Jangan menyebut dirimu sebagai FaDa AI, SAVA, ChatGPT,
  atau nama asisten lain kecuali pengguna secara khusus
  sedang membahas nama tersebut sebagai topik.
- Jika pengguna bertanya siapa kamu, jawab bahwa kamu adalah ORYVAN.

BAHASA:
- Gunakan Bahasa Indonesia secara default.
- Ikuti bahasa pengguna jika pengguna menggunakan bahasa lain.
- Gunakan bahasa yang natural dan mudah dipahami.

AKURASI:
- Jangan mengarang fakta, sumber, fitur, API, atau hasil.
- Jika informasi tidak cukup, katakan dengan jujur.
- Bedakan fakta, asumsi, dan perkiraan.
- Jangan mengklaim melakukan tindakan yang sebenarnya tidak dilakukan.

GAYA:
- Pertanyaan sederhana → jawab secara sederhana.
- Pertanyaan kompleks → gunakan struktur yang jelas.
- Hindari pengulangan yang tidak diperlukan.
- Gunakan daftar atau tabel jika memang membantu.

PEMROGRAMAN:
- Prioritaskan solusi sederhana, aman, maintainable, dan kompatibel.
- Jangan mengarang library, endpoint, parameter, atau API.
- Jangan menyarankan dependency yang tidak diperlukan.
- Jika pengguna memberikan source code, pahami kode tersebut
  sebelum menyarankan perubahan.

KEAMANAN:
- Jangan mengungkapkan API key, token, password, secret,
  environment variable rahasia, atau kredensial server.
- Jangan meminta pengguna memasukkan secret ke frontend.
- Jangan membantu mengambil atau mengekspos kredensial rahasia.
- Utamakan privasi dan keamanan.

IDENTITAS PROYEK:
- Aplikasi ini bernama ORYVAN.
- Jika pengguna meminta bantuan pengembangan ORYVAN,
  prioritaskan prinsip FREE-FIRST, MOBILE-FIRST,
  SIMPLE-FIRST, SECURITY-FIRST, dan MAINTAINABLE.
`;

function setSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');

  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );

  res.setHeader(
    'X-Frame-Options',
    'DENY'
  );

  res.setHeader(
    'Referrer-Policy',
    'no-referrer'
  );

  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
}

function sendJson(res, status, payload) {
  res.statusCode = status;

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  return res.end(
    JSON.stringify(payload)
  );
}

function getClientKey(req) {
  const forwarded =
    req.headers?.['x-forwarded-for'];

  if (
    typeof forwarded === 'string' &&
    forwarded.trim()
  ) {
    return forwarded
      .split(',')[0]
      .trim();
  }

  return (
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function isRateLimited(clientKey) {
  const now = Date.now();

  const current =
    buckets.get(clientKey);

  if (
    !current ||
    now - current.startedAt >=
      RATE_WINDOW_MS
  ) {
    buckets.set(clientKey, {
      startedAt: now,
      count: 1
    });

    return false;
  }

  current.count += 1;

  return (
    current.count >
    MAX_REQUESTS_PER_WINDOW
  );
}

function getErrorMessage(
  error,
  fallback
) {
  if (
    error &&
    typeof error.message === 'string' &&
    error.message.trim()
  ) {
    return error.message;
  }

  return fallback;
}

function parseGoogleError(
  responseText,
  status
) {
  const fallback =
    `Gemini API error (${status})`;

  if (
    typeof responseText !== 'string' ||
    !responseText.trim()
  ) {
    return fallback;
  }

  try {
    const parsed =
      JSON.parse(responseText);

    const message =
      parsed?.error?.message;

    if (
      typeof message === 'string' &&
      message.trim()
    ) {
      return message.trim();
    }
  } catch {
    // Respons bukan JSON.
  }

  if (
    responseText.length <= 2_000
  ) {
    return responseText.trim();
  }

  return fallback;
}

function isSupportedMimeType(
  mimeType
) {
  const mime =
    mimeType
      .trim()
      .toLowerCase();

  return (
    mime.startsWith('image/') ||
    mime === 'application/pdf' ||
    mime.startsWith('text/')
  );
}

function estimateBase64Bytes(
  base64
) {
  const normalized =
    base64.replace(/\s/g, '');

  return Math.floor(
    normalized.length * 0.75
  );
}

function sanitizeContents(
  contents
) {
  if (!Array.isArray(contents)) {
    throw new Error(
      'Isi percakapan tidak valid.'
    );
  }

  if (
    contents.length === 0
  ) {
    throw new Error(
      'Percakapan tidak boleh kosong.'
    );
  }

  return contents
    .slice(-MAX_CONTENTS)
    .map((message) => {
      if (
        !message ||
        typeof message !== 'object'
      ) {
        throw new Error(
          'Format pesan tidak valid.'
        );
      }

      const role =
        message.role === 'model'
          ? 'model'
          : 'user';

      if (
        !Array.isArray(
          message.parts
        )
      ) {
        throw new Error(
          'Format bagian pesan tidak valid.'
        );
      }

      const parts =
        message.parts
          .slice(
            0,
            MAX_PARTS_PER_MESSAGE
          )
          .map((part) => {
            if (
              !part ||
              typeof part !== 'object'
            ) {
              throw new Error(
                'Bagian pesan tidak valid.'
              );
            }

            if (
              typeof part.text === 'string'
            ) {
              return {
                text:
                  part.text.slice(
                    0,
                    MAX_TEXT_LENGTH
                  )
              };
            }

            if (
              part.inline_data &&
              typeof part.inline_data ===
                'object'
            ) {
              const inline =
                part.inline_data;

              if (
                typeof inline.data !==
                  'string' ||
                typeof inline.mime_type !==
                  'string'
              ) {
                throw new Error(
                  'Format lampiran tidak valid.'
                );
              }

              const mimeType =
                inline.mime_type
                  .trim()
                  .toLowerCase();

              if (
                !isSupportedMimeType(
                  mimeType
                )
              ) {
                throw new Error(
                  'Tipe lampiran tidak didukung.'
                );
              }

              const estimatedBytes =
                estimateBase64Bytes(
                  inline.data
                );

              if (
                estimatedBytes >
                MAX_FILE_BYTES
              ) {
                throw new Error(
                  'Lampiran terlalu besar. Maksimal 2 MB per file.'
                );
              }

              return {
                inline_data: {
                  mime_type:
                    mimeType,
                  data:
                    inline.data
                }
              };
            }

            throw new Error(
              'Bagian pesan tidak memiliki teks atau lampiran yang valid.'
            );
          });

      if (
        parts.length === 0
      ) {
        throw new Error(
          'Pesan tidak memiliki isi.'
        );
      }

      return {
        role,
        parts
      };
    });
}

function buildRequestBody(
  contents,
  codeExecution
) {
  const body = {
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

  if (
    codeExecution === true
  ) {
    body.tools = [
      {
        code_execution: {}
      }
    ];
  }

  return body;
}

/**
 * Membuat request ke Gemini.
 *
 * Perubahan utama versi streaming:
 * response dari Gemini TIDAK lagi dibaca
 * menggunakan response.text().
 *
 * Stream akan diteruskan langsung ke client.
 */
async function requestGemini({
  model,
  requestBody,
  apiKey,
  signal
}) {
  const url =
    `https://generativelanguage.googleapis.com/` +
    `v1beta/models/${encodeURIComponent(model)}` +
    `:streamGenerateContent?alt=sse`;

  return fetch(url, {
    method: 'POST',

    headers: {
      'Content-Type':
        'application/json',
      'x-goog-api-key':
        apiKey,
      'Accept':
        'text/event-stream'
    },

    body:
      JSON.stringify(
        requestBody
      ),

    signal
  });
}

function validateRequestBody(
  body
) {
  if (
    !body ||
    typeof body !== 'object'
  ) {
    throw new Error(
      'Format request tidak valid.'
    );
  }

  if (
    !Array.isArray(
      body.contents
    )
  ) {
    throw new Error(
      'contents harus berupa array.'
    );
  }

  if (
    body.contents.length === 0
  ) {
    throw new Error(
      'contents tidak boleh kosong.'
    );
  }

  return true;
}

/**
 * Meneruskan ReadableStream dari Gemini
 * langsung ke response client.
 *
 * Tidak menggunakan response.text()
 * sehingga streaming tetap berjalan.
 */
async function pipeGeminiStream(
  upstreamResponse,
  res
) {
  if (
    !upstreamResponse.body
  ) {
    throw new Error(
      'Gemini tidak mengembalikan response stream.'
    );
  }

  const reader =
    upstreamResponse.body.getReader();

  try {
    while (true) {
      const {
        done,
        value
      } =
        await reader.read();

      if (done) {
        break;
      }

      if (
        value &&
        value.byteLength > 0
      ) {
        res.write(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Tidak perlu melakukan apa pun.
    }
  }

  /*
   * Pastikan response selesai
   * setelah seluruh stream upstream
   * benar-benar selesai.
   */
  res.end();
}

export default async function handler(
  req,
  res
) {
  setSecurityHeaders(res);

  if (
    req.method !== 'POST'
  ) {
    res.setHeader(
      'Allow',
      'POST'
    );

    return sendJson(
      res,
      405,
      {
        error:
          'Method Not Allowed'
      }
    );
  }

  const apiKey =
    process.env.GEMINI_API_KEY;

  if (
    typeof apiKey !== 'string' ||
    !apiKey.trim()
  ) {
    return sendJson(
      res,
      500,
      {
        error:
          'GEMINI_API_KEY belum dikonfigurasi di environment server.'
      }
    );
  }

  const clientKey =
    getClientKey(req);

  if (
    isRateLimited(clientKey)
  ) {
    return sendJson(
      res,
      429,
      {
        error:
          'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.'
      }
    );
  }

  let requestBody;

  try {
    validateRequestBody(
      req.body
    );

    let serialized;

    try {
      serialized =
        JSON.stringify(
          req.body
        );
    } catch {
      return sendJson(
        res,
        400,
        {
          error:
            'Request tidak dapat diproses.'
        }
      );
    }

    if (
      Buffer.byteLength(
        serialized,
        'utf8'
      ) > MAX_BODY_BYTES
    ) {
      return sendJson(
        res,
        413,
        {
          error:
            'Request terlalu besar. Kurangi ukuran pesan atau lampiran.'
        }
      );
    }

    const requestedModel =
      typeof req.body.model ===
        'string'
        ? req.body.model.trim()
        : '';

    const model =
      ALLOWED_MODELS.has(
        requestedModel
      )
        ? requestedModel
        : DEFAULT_MODEL;

    const contents =
      sanitizeContents(
        req.body.contents
      );

    requestBody =
      buildRequestBody(
        contents,
        req.body.codeExecution ===
          true
      );

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => {
          controller.abort();
        },
        REQUEST_TIMEOUT_MS
      );

    let upstreamResponse;

    try {
      upstreamResponse =
        await requestGemini({
          model,
          requestBody,
          apiKey,
          signal:
            controller.signal
        });

      /*
       * Jangan membaca body response
       * jika Gemini mengembalikan error.
       *
       * Untuk error, kita memang perlu
       * membaca response sebagai text agar
       * bisa mendapatkan pesan error.
       */
      if (
        !upstreamResponse.ok
      ) {
        const responseText =
          await upstreamResponse.text();

        const message =
          parseGoogleError(
            responseText,
            upstreamResponse.status
          );

        console.error(
          'Gemini API error:',
          {
            model,
            status:
              upstreamResponse.status,
            message
          }
        );

        if (
          upstreamResponse.status ===
          404
        ) {
          return sendJson(
            res,
            404,
            {
              error:
                `Model "${model}" tidak ditemukan atau tidak tersedia.`
            }
          );
        }

        if (
          upstreamResponse.status ===
          400
        ) {
          return sendJson(
            res,
            400,
            {
              error:
                message ||
                'Request ke Gemini tidak valid.'
            }
          );
        }

        if (
          upstreamResponse.status ===
          401 ||
          upstreamResponse.status ===
          403
        ) {
          return sendJson(
            res,
            upstreamResponse.status,
            {
              error:
                'Gemini API menolak kredensial atau akses project server.'
            }
          );
        }

        if (
          upstreamResponse.status ===
          429
        ) {
          return sendJson(
            res,
            429,
            {
              error:
                'Kuota atau batas request Gemini sedang tercapai. Coba lagi nanti.'
            }
          );
        }

        return sendJson(
          res,
          upstreamResponse.status >=
            500
            ? 502
            : upstreamResponse.status,
          {
            error:
              message ||
              'Gemini API mengalami kesalahan.'
          }
        );
      }

      /*
       * Gemini berhasil.
       *
       * Mulai response SSE ke browser.
       */
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

      /*
       * Beberapa environment/proxy
       * mendukung flushHeaders().
       * Jika tersedia, kirim header
       * secepat mungkin.
       */
      if (
        typeof res.flushHeaders ===
        'function'
      ) {
        res.flushHeaders();
      }

      await pipeGeminiStream(
        upstreamResponse,
        res
      );

      return;
    } finally {
      clearTimeout(
        timeout
      );
    }
  } catch (error) {
    if (
      error?.name ===
      'AbortError'
    ) {
      /*
       * Jika response sudah mulai dikirim
       * sebagai SSE, jangan mencoba mengirim
       * JSON error kedua karena format response
       * sudah berbeda.
       */
      if (
        !res.headersSent
      ) {
        return sendJson(
          res,
          504,
          {
            error:
              'Permintaan ke Gemini terlalu lama dan dihentikan.'
          }
        );
      }

      try {
        res.write(
          'data: ' +
          JSON.stringify({
            error:
              'Permintaan ke Gemini terlalu lama dan dihentikan.'
          }) +
          '\n\n'
        );
        res.end();
      } catch {
        // Connection mungkin sudah tertutup.
      }

      return;
    }

    console.error(
      'ORYVAN backend error:',
      error
    );

    if (
      !res.headersSent
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            getErrorMessage(
              error,
              'Request tidak valid.'
            )
        }
      );
    }

    try {
      res.write(
        'data: ' +
        JSON.stringify({
          error:
            'ORYVAN mengalami kesalahan saat memproses stream.'
        }) +
        '\n\n'
      );

      res.end();
    } catch {
      // Connection mungkin sudah tertutup.
    }
  }
    }
