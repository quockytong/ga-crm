/** Error with a stable code. The client maps codes to Vietnamese text (src/i18n/vi.ts). */
export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503,
    public readonly code: string,
  ) {
    super(code);
  }
}

// Records of another tenant, or outside the hierarchy scope, are reported exactly
// like records that do not exist.
export const notFound = () => new ApiError(404, "not_found");
export const forbidden = () => new ApiError(403, "forbidden");
