/** Stable business rejection codes without transport status or private diagnostic payloads. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
