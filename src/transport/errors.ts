export class TimeoutError extends Error {
  readonly name = 'TimeoutError';
  constructor(message: string) {
    super(message);
  }
}

export class AuthError extends Error {
  readonly name = 'AuthError';
  constructor(message: string) {
    super(message);
  }
}

export class TransportError extends Error {
  readonly name = 'TransportError';
  constructor(message: string) {
    super(message);
  }
}
