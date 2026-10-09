export class ApiError extends Error {
    constructor(message, { status, code, details } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

const request = async (method, url, body) => {
    const options = { method, headers: {} };
    if (body instanceof FormData) {
        options.body = body;
    } else if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) {
        throw new ApiError((isJson && data.error) || `Request failed (${res.status})`, {
            status: res.status,
            code: isJson ? data.code : undefined,
            details: data,
        });
    }
    return data;
};

export const api = {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body ?? {}),
    put: (url, body) => request('PUT', url, body ?? {}),
    patch: (url, body) => request('PATCH', url, body ?? {}),
    delete: (url) => request('DELETE', url),
};
