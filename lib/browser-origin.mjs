// Пароль запрашивает HTTPS proxy; здесь блокируются запросы браузера с чужих сайтов.
export function browserOriginAllowed(request, allowedOrigins) {
  const origin = request.headers.origin;
  return request.headers['sec-fetch-site'] !== 'cross-site' && (!origin || allowedOrigins.has(origin));
}
