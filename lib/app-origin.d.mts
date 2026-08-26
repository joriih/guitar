export declare const DEFAULT_APP_ORIGIN: "http://127.0.0.1:3000";

export declare function normalizeAppOrigin(value: string): string;

export declare function isLoopbackAppOrigin(value: string | null): boolean;

export declare function allowedAppOrigins(
  configuredOrigin?: string,
  remoteAccessValue?: string,
): readonly string[];

export declare function isAllowedAppOrigin(
  origin: string | null,
  configuredOrigin?: string,
  remoteAccessValue?: string,
): boolean;

export declare function isSecureAppRequest(
  request: Request,
  configuredOrigin?: string,
  remoteAccessValue?: string,
): boolean;
