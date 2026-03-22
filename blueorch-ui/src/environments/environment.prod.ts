// Production environment — Angular is served by the same Express server,
// so all API calls use a relative path (same host + port).
// This means the UI automatically adapts to whatever port npx blueorch runs on.
export const environment = {
  production: true,
  apiUrl: '',
};
