const request = async (url: string, options: RequestInit = {}) => {
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return response.json();
};

export const api = {
  list: (type: string, status = 'active') =>
    request(`/api/admin/${type}?status=${encodeURIComponent(status)}`),

  create: (type: string, data: Record<string, unknown>) =>
    request(`/api/admin/${type}`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  update: (type: string, id: string, data: Record<string, unknown>) =>
    request(`/api/admin/${type}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    }),

  archive: (type: string, id: string) =>
    request(`/api/admin/${type}/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      body: JSON.stringify({})
    }),

  restore: (type: string, id: string) =>
    request(`/api/admin/${type}/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify({})
    }),

  del: (type: string, id: string) =>
    request(
      `/api/admin/${type}/${encodeURIComponent(id)}?confirm=PERMANENTLY_DELETE`,
      {
        method: 'DELETE'
      }
    )
};
