import type { BusinessError, ErrorCode } from '@pantrymos/shared';

type Details = Omit<BusinessError, 'code' | 'message'>;

/**
 * An expected business outcome (IMPLEMENTATION_PLAN §7.1), not a fault. Thrown from domain code;
 * the request log stores it as the request's durable result, and MCP tools return it with `isError: true`.
 */
export class PantryError extends Error {
  readonly code: ErrorCode;
  readonly details: Details;
  /** HTTP status used by internal routes. */
  readonly status: number;

  constructor(code: ErrorCode, message: string, details: Details = {}, status = 409) {
    super(message);
    this.name = 'PantryError';
    this.code = code;
    this.details = details;
    this.status = status;
  }

  toBody(): BusinessError {
    return { code: this.code, message: this.message, ...this.details };
  }
}
