// See the top of jupyterlab-markus-extension.test.ts for why PageConfig is
// mocked rather than imported for real.
jest.mock('@jupyterlab/coreutils', () => ({
  PageConfig: {
    getBaseUrl: jest.fn(),
    getToken: jest.fn()
  }
}));

import { PageConfig } from '@jupyterlab/coreutils';

import {
  authenticateWithMarkUs,
  fetchAvailableAssignments,
  getOrCreateSession,
  invalidateSession,
  MarkUsServerError
} from '../session';

const mockGetBaseUrl = PageConfig.getBaseUrl as jest.Mock;
const mockGetToken = PageConfig.getToken as jest.Mock;

describe('authenticateWithMarkUs', () => {
  const markusUrl = 'http://localhost:3000/';

  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockGetBaseUrl.mockReset().mockReturnValue('http://localhost:8888/');
    mockGetToken.mockReset().mockReturnValue('test-token');
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
  });

  it('posts the jupyter base_url/token and returns the parsed session response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: 'success',
          session_token: 'sess-abc',
          expires_at: '2026-08-25T12:15:00Z',
          markus_user_name: 'c9user'
        })
    });

    const result = await authenticateWithMarkUs(markusUrl);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/jupyter/authenticate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          jupyter: { base_url: 'http://localhost:8888/', token: 'test-token' }
        })
      })
    );
    expect(result).toEqual({
      status: 'success',
      session_token: 'sess-abc',
      expires_at: '2026-08-25T12:15:00Z',
      markus_user_name: 'c9user'
    });
  });

  it('throws a MarkUsServerError carrying the status and server message on failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({ status: 'error', message: 'Invalid Jupyter token.', error_class: 'IdentityError' })
    });

    let caught: unknown;
    try {
      await authenticateWithMarkUs(markusUrl);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MarkUsServerError);
    expect((caught as MarkUsServerError).status).toBe(401);
    expect((caught as MarkUsServerError).message).toContain('Invalid Jupyter token.');
  });

  it('throws when no Jupyter token is available', async () => {
    mockGetToken.mockReturnValue('');
    await expect(authenticateWithMarkUs(markusUrl)).rejects.toThrow('No Jupyter token available.');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('getOrCreateSession / invalidateSession', () => {
  // A distinct base URL per describe block keeps the module-level session
  // cache from leaking state between suites.
  const markusUrl = 'http://session-cache.example.com/';

  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockGetBaseUrl.mockReset().mockReturnValue('http://localhost:8888/');
    mockGetToken.mockReset().mockReturnValue('test-token');
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
    invalidateSession(markusUrl);
  });

  function mockAuthSuccess(sessionToken: string, expiresAt: string): void {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'success', session_token: sessionToken, expires_at: expiresAt })
    });
  }

  it('authenticates once and reuses the cached token within its TTL', async () => {
    mockAuthSuccess('sess-1', new Date(Date.now() + 60_000).toISOString());

    const first = await getOrCreateSession(markusUrl);
    const second = await getOrCreateSession(markusUrl);

    expect(first).toBe('sess-1');
    expect(second).toBe('sess-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('re-authenticates once the cached token is within the expiry safety margin', async () => {
    mockAuthSuccess('sess-1', new Date(Date.now() + 5_000).toISOString());
    mockAuthSuccess('sess-2', new Date(Date.now() + 60_000).toISOString());

    const first = await getOrCreateSession(markusUrl);
    const second = await getOrCreateSession(markusUrl);

    expect(first).toBe('sess-1');
    expect(second).toBe('sess-2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('re-authenticates after invalidateSession is called', async () => {
    mockAuthSuccess('sess-1', new Date(Date.now() + 60_000).toISOString());
    mockAuthSuccess('sess-2', new Date(Date.now() + 60_000).toISOString());

    const first = await getOrCreateSession(markusUrl);
    invalidateSession(markusUrl);
    const second = await getOrCreateSession(markusUrl);

    expect(first).toBe('sess-1');
    expect(second).toBe('sess-2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws when the response is missing session_token or expires_at', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'success' })
    });

    await expect(getOrCreateSession(markusUrl)).rejects.toThrow(/missing "session_token" or "expires_at"/);
  });

  it('throws when expires_at cannot be parsed', async () => {
    mockAuthSuccess('sess-1', 'not-a-date');

    await expect(getOrCreateSession(markusUrl)).rejects.toThrow(/invalid "expires_at" value/);
  });
});

describe('fetchAvailableAssignments', () => {
  const markusUrl = 'http://assignments.example.com/';

  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockGetBaseUrl.mockReset().mockReturnValue('http://localhost:8888/');
    mockGetToken.mockReset().mockReturnValue('test-token');
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
    invalidateSession(markusUrl);
  });

  it('authenticates and returns the available courses and assignments', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'success',
            session_token: 'sess-1',
            expires_at: new Date(Date.now() + 60_000).toISOString()
          })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'success',
            courses: [
              {
                id: 1,
                name: 'csc108',
                display_name: 'Introduction to Computer Programming',
                assignments: [
                  {
                    id: 2,
                    short_identifier: 'A1',
                    description: 'Assignment 1'
                  }
                ]
              }
            ]
          })
      });

    const result = await fetchAvailableAssignments(markusUrl);

    expect(result).toEqual({
      status: 'success',
      courses: [
        {
          id: 1,
          name: 'csc108',
          display_name: 'Introduction to Computer Programming',
          assignments: [
            {
              id: 2,
              short_identifier: 'A1',
              description: 'Assignment 1'
            }
          ]
        }
      ]
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);

    expect(mockFetch.mock.calls[1][0]).toBe(
      'http://assignments.example.com/jupyter/assignments'
    );

    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
      session_token: 'sess-1',
      jupyter: {
        base_url: 'http://localhost:8888/',
        token: 'test-token'
      }
    });
  });

  it('re-authenticates and retries once when the assignments request returns 401', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
        JSON.stringify({
            status: 'success',
            session_token: 'sess-1',
            expires_at: new Date(Date.now() + 60_000).toISOString()
          })
        })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () =>
        JSON.stringify({
          status: 'error',
          message: 'Session expired.'
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
        JSON.stringify({
          status: 'success',
          session_token: 'sess-2',
          expires_at: new Date(Date.now() + 60_000).toISOString()
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
        JSON.stringify({
          status: 'success',
          courses: []
        })
      });
    
    const result = await fetchAvailableAssignments(markusUrl);
    
    expect(result).toEqual({
      status: 'success',
      courses: []
    });
    
    expect(mockFetch).toHaveBeenCalledTimes(4);
    
    const retriedBody = JSON.parse(
      mockFetch.mock.calls[3][1].body
    );
    
    expect(retriedBody.session_token).toBe('sess-2');
  });
    
  it('propagates non-401 assignment request failures without retrying', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'success',
            session_token: 'sess-1',
            expires_at: new Date(Date.now() + 60_000).toISOString()
          })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            status: 'error',
            message: 'Not authorized.'
          })
      });

    await expect(
      fetchAvailableAssignments(markusUrl)
    ).rejects.toMatchObject({
      name: 'MarkUsServerError',
      status: 403
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
