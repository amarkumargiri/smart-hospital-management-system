import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, tokens } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!tokens.access) {
      setUser(null);
      setLoading(false);
      return null;
    }
    try {
      const me = await api.get('/auth/me');
      setUser(me);
      return me;
    } catch {
      tokens.clear();
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const value = useMemo(() => ({
    user,
    loading,
    reload: load,
    async login(identifier, password) {
      const res = await api.post('/auth/login', { identifier, password });
      if (res.requiresOtp) return res; // caller shows the OTP step
      tokens.set(res);
      return load();
    },
    async verifyOtp({ userId, code, purpose }) {
      const res = await api.post('/auth/verify-otp', { userId, code, purpose });
      tokens.set(res);
      return load();
    },
    async logout() {
      await api.post('/auth/logout', { refreshToken: tokens.refresh }).catch(() => {});
      tokens.clear();
      setUser(null);
    },
  }), [user, loading, load]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

// Where each role lands after signing in.
export const HOME_FOR_ROLE = {
  PATIENT: '/app',
  DOCTOR: '/doctor',
  RECEPTIONIST: '/reception',
};
