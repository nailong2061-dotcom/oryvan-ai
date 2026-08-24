const ALLOWED_MODELS = new Set([
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
]);

const DEFAULT_MODEL = 'gemini-3.6-flash';

/*
 * Instruksi inti ORYVAN berada di backend.
 *
 * Dengan begitu frontend tidak menjadi sumber utama
 * identitas/instruksi sistem ORYVAN.
 */
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

/* ================================
   LIMITS
================================ */

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MAX_CONTENTS = 40;

const MAX_PARTS_PER_MESSAGE = 12;

const MAX_TEXT_LENGTH = 120_000;

const MAX_TOTAL_TEXT_LENGTH = 350_000;

const MAX_INLINE_DATA_BYTES = 2_500_000;

const MAX_INLINE_ATTACHMENTS = 6;

const MAX_REQUESTS_PER_WINDOW = 30;

const RATE_WINDOW_MS = 60_000;

/*
 * In-memory rate limiter.
 *
 * Cocok untuk perlindungan dasar proyek pribadi.
 * Pada serverless, instance dapat berubah sehingga
 * ini bukan pengganti rate limiter terdistribusi.
 */
const buckets = new Map();

/* ================================
   ALLOWED MIME TYPES
================================ */

const ALLOWED_INLINE_MIME_PREFIXES = [
  'image/',
  'audio/',
  'video/'
];

const ALLOWED_INLINE_MIME_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json'
]);

/* ================================
   UTILITY
================================ */

function sendJson(res, status, payload) {
  if (res.headersSent) {
    return;
  }

  res.statusCode = status;

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  res.setHeader(
    'Cache-Control',
    'no-store'
  );

  return res.end(
    JSON.stringify(payload)
  );
}

function setSecurityHeaders(res) {
  res.setHeader(
    'Cache-Control',
    'no-store'
  );

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

  /*
   * API ini tidak dimaksudkan untuk menjadi
   * halaman HTML yang boleh di-embed.
   */
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; frame-ancestors 'none'"
  );
}

function getClientKey(req) {
  /*
   * Pada platform seperti Vercel, x-forwarded-for
   * biasanya diisi oleh infrastructure proxy.
   *
   * Jangan menggunakan API key atau cookie sebagai
   * identifier rate limit.
   */
  const forwarded =
    req.headers?.['x-forwarded-for'];

  if (
    typeof forwarded === 'string' &&
    forwarded.trim()
  ) {
    return forwarded
      .split(',')[0]
      .trim()
      .slice(0, 128);
  }

  const realIp =
    req.headers?.['x-real-ip'];

  if (
    typeof realIp === 'string' &&
    realIp.trim()
  ) {
    return realIp
      .trim()
      .slice(0, 128);
  }

  return (
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function rateLimited(key) {
  const now = Date.now();

  const current = buckets.get(key);

  if (
    !current ||
    now - current.startedAt >= RATE_WINDOW_MS
  ) {
    buckets.set(key, {
      startedAt: now,
      count: 1
    });

    cleanupBuckets(now);

    return false;
  }

  current.count += 1;

  return (
    current.count >
    MAX_REQUESTS_PER_WINDOW
  );
}

function cleanupBuckets(now) {
  /*
   * Mencegah Map terus membesar jika banyak
   * client berbeda mengakses endpoint.
   */
  if (buckets.size < 500) {
    return;
  }

  for (const [
    key,
    bucket
  ] of buckets) {
    if (
      now - bucket.startedAt >=
      RATE_WINDOW_MS
    ) {
      buckets.delete(key);
    }
  }
}

function byteLength(value) {
  return Buffer.byteLength(
    value,
    'utf8'
  );
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function isAllowedMimeType(mimeType) {
  if (
    typeof mimeType !== 'string' ||
    !mimeType
  ) {
    return false;
  }

  const normalized =
    mimeType
      .toLowerCase()
      .split(';')[0]
      .trim();

  if (
    ALLOWED_INLINE_MIME_TYPES.has(
      normalized
    )
  ) {
    return true;
  }

  return ALLOWED_INLINE_MIME_PREFIXES.some(
    (prefix) =>
      normalized.startsWith(prefix)
  );
}

function isValidBase64(value) {
  if (
    typeof value !== 'string' ||
    !value
  ) {
    return false;
  }

  /*
   * Base64 yang dikirim frontend seharusnya
   * hanya berisi karakter base64 tanpa data URL.
   */
  if (
    value.length % 4 !== 0
  ) {
    return false;
  }

  return /^[A-Za-z0-9+/]*={0,2}$/.test(
    value
  );
}

function estimateBase64Bytes(base64) {
  const padding =
    base64.endsWith('==')
      ? 2
      : base64.endsWith('=')
        ? 1
        : 0;

  return Math.floor(
    (base64.length * 3) / 4
  ) - padding;
}

function sanitizeErrorMessage(
  status,
  rawMessage
) {
  const message =
    typeof rawMessage === 'string'
      ? rawMessage.toLowerCase()
      : '';

  if (status === 400) {
    return 'Permintaan ORYVAN tidak valid.';
  }

  if (
    status === 401 ||
    status === 403
  ) {
    return 'Konfigurasi akses AI pada server bermasalah.';
  }

  if (status === 404) {
    return 'Model AI yang dipilih tidak tersedia.';
  }

  if (status === 429) {
    if (
      message.includes('quota') ||
      message.includes('resource exhausted')
    ) {
      return 'Kuota Gemini sedang tercapai. Coba lagi nanti.';
    }

    return 'Batas permintaan ORYVAN sedang tercapai. Tunggu sebentar lalu coba lagi.';
  }

  if (status >= 500) {
    return 'Layanan AI sedang mengalami gangguan. Coba lagi nanti.';
  }

  return 'Permintaan ke layanan AI gagal diproses.';
}

/* ================================
   REQUEST VALIDATION
================================ */

function validateTextPart(
  part,
  counters
) {
  if (
    !isPlainObject(part)
  ) {
    return 'Format bagian pesan tidak valid.';
  }

  if (
    typeof part.text !== 'string'
  ) {
    return null;
  }

  if (
    part.text.length >
    MAX_TEXT_LENGTH
  ) {
    return 'Teks pesan terlalu panjang.';
  }

  counters.totalTextLength +=
    part.text.length;

  if (
    counters.totalTextLength >
    MAX_TOTAL_TEXT_LENGTH
  ) {
    return 'Total teks percakapan terlalu panjang.';
  }

  return null;
}

function validateInlineDataPart(
  part,
  counters
) {
  if (
    !isPlainObject(part.inline_data)
  ) {
    return null;
  }

  const inlineData =
    part.inline_data;

  if (
    typeof inlineData.mime_type !==
    'string'
  ) {
    return 'MIME type lampiran tidak valid.';
  }

  const mimeType =
    inlineData.mime_type
      .toLowerCase()
      .split(';')[0]
      .trim();

  if (
    !isAllowedMimeType(mimeType)
  ) {
    return 'Jenis file tersebut tidak didukung.';
  }

  if (
    typeof inlineData.data !==
    'string'
  ) {
    return 'Data lampiran tidak valid.';
  }

  if (
    !isValidBase64(
      inlineData.data
    )
  ) {
    return 'Format data lampiran tidak valid.';
  }

  const estimatedBytes =
    estimateBase64Bytes(
      inlineData.data
    );

  if (
    estimatedBytes >
    MAX_INLINE_DATA_BYTES
  ) {
    return 'Ukuran lampiran terlalu besar.';
  }

  counters.inlineAttachments += 1;

  if (
    counters.inlineAttachments >
    MAX_INLINE_ATTACHMENTS
  ) {
    return 'Jumlah lampiran dalam satu permintaan terlalu banyak.';
  }

  return null;
}

function validatePart(
  part,
  counters
) {
  if (
    !isPlainObject(part)
  ) {
    return 'Format part pesan tidak valid.';
  }

  const keys =
    Object.keys(part);

  /*
   * Part harus menggunakan format yang
   * dikenal Gemini. Jangan meneruskan objek
   * arbitrary dari client.
   */
  const allowedKeys = new Set([
    'text',
    'inline_data'
  ]);

  for (const key of keys) {
    if (!allowedKeys.has(key)) {
      return 'Format pesan mengandung properti yang tidak didukung.';
    }
  }

  if (
    typeof part.text === 'string'
  ) {
    const textError =
      validateTextPart(
        part,
        counters
      );

    if (textError) {
      return textError;
    }
  }

  if (
    part.inline_data
  ) {
    const attachmentError =
      validateInlineDataPart(
        part,
        counters
      );

    if (attachmentError) {
      return attachmentError;
    }
  }

  if (
    typeof part.text !== 'string' &&
    !part.inline_data
  ) {
    return 'Part pesan tidak memiliki konten yang didukung.';
  }

  return null;
}

function validateContents(
  contents
) {
  if (
    !Array.isArray(contents) ||
    contents.length === 0
  ) {
    return {
      error:
        'Isi percakapan tidak valid.'
    };
  }

  if (
    contents.length >
    MAX_CONTENTS
  ) {
    return {
      error:
        'Percakapan terlalu panjang.'
    };
  }

  const counters = {
    totalTextLength: 0,
    inlineAttachments: 0
  };

  const validated = [];

  for (
    const message of contents
  ) {
    if (
      !isPlainObject(message)
    ) {
      return {
        error:
          'Format pesan percakapan tidak valid.'
      };
    }

    /*
     * Gemini menggunakan:
     * user
     * model
     *
     * Jangan izinkan client mengirim
     * system/developer role sendiri.
     */
    if (
      message.role !== 'user' &&
      message.role !== 'model'
    ) {
      return {
        error:
          'Role pesan tidak valid.'
      };
    }

    if (
      !Array.isArray(
        message.parts
      )
    ) {
      return {
        error:
          'Format parts pesan tidak valid.'
      };
    }

    if (
      message.parts.length === 0
    ) {
      return {
        error:
          'Pesan tidak memiliki konten.'
      };
    }

    if (
      message.parts.length >
      MAX_PARTS_PER_MESSAGE
    ) {
      return {
        error:
          'Terlalu banyak lampiran atau bagian dalam satu pesan.'
      };
    }

    const cleanParts = [];

    for (
      const part of message.parts
    ) {
      const partError =
        validatePart(
          part,
          counters
        );

      if (partError) {
        return {
          error: partError
        };
      }

      /*
       * Hanya salin field yang memang
       * diperlukan Gemini.
       */
      if (
        typeof part.text ===
        'string'
      ) {
        cleanParts.push({
          text: part.text
        });
      } else if (
        part.inline_data
      ) {
        cleanParts.push({
          inline_data: {
            mime_type:
              part.inline_data
                .mime_type
                .toLowerCase()
                .split(';')[0]
                .trim(),

            data:
              part.inline_data
                .data
          }
        });
      }
    }

    validated.push({
      role: message.role,
      parts: cleanParts
    });
  }

  return {
    contents: validated
  };
}

/* ================================
   GEMINI ERROR PARSING
================================ */

async function readErrorResponse(
  response
) {
  try {
    const text =
      await response.text();

    if (!text) {
      return '';
    }

    try {
      const parsed =
        JSON.parse(text);

      if (
        parsed?.error?.message
      ) {
        return String(
          parsed.error.message
        );
      }
    } catch {
      /*
       * Bukan JSON.
       */
    }

    return text.slice(0, 500);
  } catch {
    return '';
  }
}

/* ================================
   MAIN HANDLER
================================ */

export default async function handler(
  req,
  res
) {
  setSecurityHeaders(res);

  /*
   * Hanya POST.
   */
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

  /*
   * API key hanya dibaca dari server.
   */
  const apiKey =
    process.env.GEMINI_API_KEY;

  if (
    typeof apiKey !== 'string' ||
    !apiKey.trim()
  ) {
    console.error(
      'GEMINI_API_KEY tidak tersedia di environment server.'
    );

    return sendJson(
      res,
      500,
      {
        error:
          'Konfigurasi server belum lengkap.'
      }
    );
  }

  /*
   * Basic rate limit.
   */
  const clientKey =
    getClientKey(req);

  if (
    rateLimited(clientKey)
  ) {
    return sendJson(
      res,
      429,
      {
        error:
          'Batas permintaan ORYVAN tercapai. Tunggu sebentar lalu coba lagi.'
      }
    );
  }

  /*
   * Periksa Content-Length jika tersedia.
   *
   * Ini membantu menolak request besar
   * sebelum diproses lebih lanjut.
   */
  const contentLengthHeader =
    req.headers?.['content-length'];

  if (
    contentLengthHeader
  ) {
    const contentLength =
      Number(
        contentLengthHeader
      );

    if (
      Number.isFinite(
        contentLength
      ) &&
      contentLength >
        MAX_BODY_BYTES
    ) {
      return sendJson(
        res,
        413,
        {
          error:
            'Permintaan terlalu besar. Kurangi ukuran pesan atau lampiran.'
        }
      );
    }
  }

  try {
    const body =
      req.body &&
      typeof req.body ===
        'object'
        ? req.body
        : null;

    if (
      !body ||
      Array.isArray(body)
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Format permintaan tidak valid.'
        }
      );
    }

    /*
     * Pastikan body tidak terlalu besar.
     *
     * Ini tetap dilakukan karena Content-Length
     * tidak selalu tersedia.
     */
    let serialized;

    try {
      serialized =
        JSON.stringify(body);
    } catch {
      return sendJson(
        res,
        400,
        {
          error:
            'Format permintaan tidak valid.'
        }
      );
    }

    if (
      byteLength(serialized) >
      MAX_BODY_BYTES
    ) {
      return sendJson(
        res,
        413,
        {
          error:
            'Permintaan terlalu besar. Kurangi ukuran pesan atau lampiran.'
        }
      );
    }

    /*
     * Model allowlist.
     */
    const requestedModel =
      typeof body.model ===
      'string'
        ? body.model.trim()
        : '';

    const model =
      ALLOWED_MODELS.has(
        requestedModel
      )
        ? requestedModel
        : DEFAULT_MODEL;

    /*
     * Validasi conversation.
     *
     * Hanya field yang diperlukan yang
     * diteruskan ke Gemini.
     */
    const validation =
      validateContents(
        body.contents
      );

    if (validation.error) {
      return sendJson(
        res,
        400,
        {
          error:
            validation.error
        }
      );
    }

    const contents =
      validation.contents;

    /*
     * System instruction selalu berasal
     * dari backend.
     */
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
     * Code Execution tetap OFF secara default.
     *
     * Frontend hanya dapat mengaktifkannya
     * dengan mengirim:
     *
     * codeExecution: true
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

    /*
     * Abort controller digunakan untuk
     * mencegah request menggantung terlalu lama.
     */
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => {
          controller.abort();
        },
        55_000
      );

    let response;

    try {
      response =
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model
          )}:streamGenerateContent?alt=sse`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json',

              'Accept':
                'text/event-stream',

              'x-goog-api-key':
                apiKey
            },

            body:
              JSON.stringify(
                requestBody
              ),

            signal:
              controller.signal
          }
        );
    } catch (error) {
      if (
        error?.name ===
        'AbortError'
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

      console.error(
        'ORYVAN Gemini connection error:',
        error
      );

      return sendJson(
        res,
        502,
        {
          error:
            'Tidak dapat terhubung ke layanan AI.'
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    /*
     * Gemini mengembalikan error non-2xx
     * sebagai response biasa.
     */
    if (
      !response.ok
    ) {
      const rawError =
        await readErrorResponse(
          response
        );

      const safeMessage =
        sanitizeErrorMessage(
          response.status,
          rawError
        );

      /*
       * Detail error hanya dicatat
       * di server untuk debugging.
       */
      console.error(
        'Gemini API error:',
        response.status,
        rawError
      );

      return sendJson(
        res,
        response.status,
        {
          error:
            safeMessage
        }
      );
    }

    /*
     * Pastikan Gemini benar-benar
     * memberikan stream.
     */
    if (
      !response.body
    ) {
      return sendJson(
        res,
        502,
        {
          error:
            'Gemini tidak mengembalikan stream respons.'
        }
      );
    }

    /*
     * TRUE STREAMING
     *
     * Versi sebelumnya menggunakan:
     *
     * await response.text()
     *
     * sehingga backend menunggu seluruh
     * respons selesai terlebih dahulu.
     *
     * Sekarang chunk dari Gemini langsung
     * diteruskan ke browser.
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
     * Jangan buffering response jika
     * platform mendukung header ini.
     */
    res.setHeader(
      'X-Accel-Buffering',
      'no'
    );

    const reader =
      response.body.getReader();

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

        /*
         * Node/Vercel response.end()
         * tidak digunakan di sini sampai
         * seluruh stream selesai.
         *
         * write() meneruskan setiap chunk
         * sesegera mungkin.
         */
        res.write(
          Buffer.from(value)
        );
      }
    } catch (error) {
      /*
       * Jika client menutup koneksi,
       * hentikan pembacaan stream.
       */
      try {
        await reader.cancel();
      } catch {
        // Tidak perlu melakukan apa-apa.
      }

      console.error(
        'ORYVAN stream error:',
        error
      );

      /*
       * Jika header sudah dikirim, jangan
       * mencoba mengirim JSON error karena
       * response sudah berupa SSE.
       */
      if (!res.writableEnded) {
        res.end();
      }

      return;
    }

    return res.end();
  } catch (error) {
    console.error(
      'ORYVAN backend error:',
      error
    );

    /*
     * Jangan membocorkan error internal
     * ke client.
     */
    if (
      res.headersSent
    ) {
      if (
        !res.writableEnded
      ) {
        res.end();
      }

      return;
    }

    return sendJson(
      res,
      500,
      {
        error:
          'Terjadi kesalahan pada backend ORYVAN.'
      }
    );
  }
    }
