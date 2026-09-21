import { PageConfig } from '@jupyterlab/coreutils';

// An error thrown by a MarkUs HTTP call, carrying the response status so
// callers can distinguish retryable failures (401) from everything else.
export class MarkUsServerError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'MarkUsServerError';
  }
}

// The authenticate response
interface ISessionResponse {
  status: string;
  session_token?: string;
  expires_at?: string;
  markus_user_name?: string;
  message?: string;
}

export interface IMarkUsAssignment {
  id: number;
  short_identifier: string;
  description: string | null;
  due_date: string | null;
}

export interface IMarkUsCourse {
  id: number;
  name: string;
  display_name: string | null;
  assignments: IMarkUsAssignment[];
}

export interface IAssignmentsResponse {
  status: string;
  courses: IMarkUsCourse[];
  reason?:
      | 'no_enrollment'
      | 'no_available_assignments'
      | 'api_submission_disabled';
  message?: string;
}

// Read a Jupyter base_url/token pair from PageConfig.
export function getJupyterCredentials(): { base_url: string; token: string } {
  const jupyterBaseUrl = PageConfig.getBaseUrl();
  const jupyterToken = PageConfig.getToken();

  if (!jupyterToken) {
    throw new Error(
      'No Jupyter token available. This environment may be using cookie/OAuth authentication. Token-based pull may not work.'
    );
  }

  return { base_url: jupyterBaseUrl, token: jupyterToken };
}

// Extract a human-readable message from a MarkUs error response body,
// which is JSON of the form {status, message, error_class}.
export function extractErrorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    // Not JSON -- fall through to using the raw text below.
  }

  return text || `HTTP ${status}`;
}

// Authenticate with the MarkUs server to obtain a short-lived session token.
export async function authenticateWithMarkUs(
  markusUrl: string
): Promise<ISessionResponse> {
  const authUrl = new URL('jupyter/authenticate', markusUrl).toString();

  const response = await fetch(authUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ jupyter: getJupyterCredentials() })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new MarkUsServerError(
      `MarkUs server error ${response.status}: ${extractErrorMessage(
        response.status,
        text
      )}`,
      response.status
    );
  }

  return JSON.parse(text) as ISessionResponse;
}

// Cache of live session tokens, keyed by normalized MarkUs base URL.
// A single JupyterLab install could submit to multiple MarkUs deployments,
// including deployments hosted under different paths on the same origin.
interface ISessionCacheEntry {
  sessionToken: string;
  expiresAt: number; // epoch ms
}

const sessionCache = new Map<string, ISessionCacheEntry>();

// Don't reuse a token expiring within this margin, to avoid a race where it
// expires mid-request.
const SESSION_EXPIRY_SAFETY_MARGIN_MS = 30_000;

function getMarkusCacheKey(markusUrl: string): string {
  const url = new URL(markusUrl);
  url.pathname = url.pathname.replace(/\/?$/, '/');
  return url.toString();
}

// Drop any cached session for this MarkUs base URL, forcing the next
// getOrCreateSession call to re-authenticate.
export function invalidateSession(markusUrl: string): void {
  sessionCache.delete(getMarkusCacheKey(markusUrl));
}

// Return a live session token for this MarkUs base URL, reusing a cached one
// if it isn't close to expiring, otherwise authenticating for a fresh one.
export async function getOrCreateSession(
  markusUrl: string
): Promise<string> {
  const cacheKey = getMarkusCacheKey(markusUrl);
  const cached = sessionCache.get(cacheKey);

  if (
    cached &&
    cached.expiresAt - SESSION_EXPIRY_SAFETY_MARGIN_MS > Date.now()
  ) {
    return cached.sessionToken;
  }

  const response = await authenticateWithMarkUs(markusUrl);

  if (!response.session_token || !response.expires_at) {
    throw new Error(
      'MarkUs authentication response is missing "session_token" or "expires_at".'
    );
  }

  const expiresAt = Date.parse(response.expires_at);

  if (Number.isNaN(expiresAt)) {
    throw new Error(
      `MarkUs authentication response has an invalid "expires_at" value: "${response.expires_at}".`
    );
  }

  sessionCache.set(cacheKey, {
    sessionToken: response.session_token,
    expiresAt
  });

  return response.session_token;
}

export async function fetchAvailableAssignments(
  markusUrl: string
): Promise<IAssignmentsResponse> {
  const assignmentsUrl = new URL('jupyter/assignments', markusUrl).toString();

  let sessionToken = await getOrCreateSession(markusUrl);

  const makeRequest = async (token: string): Promise<Response> => {
    return fetch(assignmentsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        session_token: token,
        jupyter: getJupyterCredentials()
      })
    });
  };

  let response = await makeRequest(sessionToken);

  if (response.status === 401) {
    invalidateSession(markusUrl);
    sessionToken = await getOrCreateSession(markusUrl);
    response = await makeRequest(sessionToken);
  }

  const text = await response.text();

  if (!response.ok) {
    throw new MarkUsServerError(
      `MarkUs server error ${response.status}: ${extractErrorMessage(
        response.status,
        text
      )}`,
      response.status
    );
  }

  return JSON.parse(text) as IAssignmentsResponse;
}
