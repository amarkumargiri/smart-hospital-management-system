// Small HTTP helpers shared by every route module.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Authentication required.') => new HttpError(401, msg);
export const forbidden = (msg = 'You do not have permission to access this record.') =>
  new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);

// Wraps an async route handler so rejections reach the error middleware.
export const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

// Validates the request body/query against a zod schema and returns parsed data.
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('Validation failed.', result.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    })));
  }
  return result.data;
}

// Prisma Decimal serialises to a string by default, which turns every money
// field into "900" on the client. The replacer reads the original value off the
// holder (JSON.stringify applies toJSON before handing the value over) and
// converts Decimals to numbers.
export function serialize(value) {
  return JSON.parse(JSON.stringify(value, function replacer(key, serialized) {
    const raw = this[key];
    if (raw && typeof raw === 'object' && typeof raw.toNumber === 'function') return raw.toNumber();
    return serialized;
  }));
}
