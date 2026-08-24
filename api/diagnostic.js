const ALLOWED_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method !== 'GET') {
    res.statusCode = 405;

    res.setHeader('Allow', 'GET');

    return res.end(
      JSON.stringify({
        error: 'Method Not Allowed'
      })
    );
  }

  const apiKey =
    process.env.GEMINI_API_KEY;

  if (
    typeof apiKey !== 'string' ||
    !apiKey.trim()
  ) {
    res.statusCode = 500;

    return res.end(
      JSON.stringify({
        error:
          'GEMINI_API_KEY tidak tersedia di environment server.'
      })
    );
  }

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      {
        method: 'GET',

        headers: {
          'x-goog-api-key': apiKey
        }
      }
    );

    const rawText =
      await response.text();

    if (!response.ok) {
      console.error(
        'Gemini ListModels error:',
        response.status,
        rawText
      );

      res.statusCode =
        response.status >= 500
          ? 502
          : response.status;

      return res.end(
        JSON.stringify({
          error:
            'Gagal membaca daftar model dari Gemini API.',
          status:
            response.status
        })
      );
    }

    let data;

    try {
      data =
        JSON.parse(rawText);
    } catch {
      res.statusCode = 502;

      return res.end(
        JSON.stringify({
          error:
            'Gemini mengembalikan data yang tidak valid.'
        })
      );
    }

    const models =
      Array.isArray(data.models)
        ? data.models
        : [];

    const availableModels =
      models
        .map((model) => {
          const name =
            typeof model.name === 'string'
              ? model.name.replace(
                  /^models\//,
                  ''
                )
              : '';

          return {
            name,
            displayName:
              model.displayName || '',
            supportedGenerationMethods:
              Array.isArray(
                model.supportedGenerationMethods
              )
                ? model.supportedGenerationMethods
                : []
          };
        })
        .filter(
          (model) => model.name
        );

    const results =
      ALLOWED_MODELS.map(
        (requestedModel) => {
          const found =
            availableModels.find(
              (model) =>
                model.name ===
                requestedModel
            );

          return {
            model:
              requestedModel,

            available:
              Boolean(found),

            supportsGenerateContent:
              found?.supportedGenerationMethods?.includes(
                'generateContent'
              ) || false,

            supportsBatchGenerateContent:
              found?.supportedGenerationMethods?.includes(
                'batchGenerateContent'
              ) || false
          };
        }
      );

    res.statusCode = 200;

    res.setHeader(
      'Content-Type',
      'application/json; charset=utf-8'
    );

    return res.end(
      JSON.stringify(
        {
          ok: true,

          message:
            'Diagnosis model ORYVAN berhasil.',

          checkedModels:
            results,

          /*
           * Hanya informasi model.
           * API key tidak pernah dikirim
           * ke browser.
           */
          availableModels:
            availableModels
              .filter((model) =>
                ALLOWED_MODELS.includes(
                  model.name
                )
              )
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      'Diagnostic error:',
      error
    );

    res.statusCode = 502;

    return res.end(
      JSON.stringify({
        error:
          'Tidak dapat terhubung ke Gemini API.'
      })
    );
  }
}
