import { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithPopup } from "firebase/auth";
import { HeartPulse } from "lucide-react";
import { auth, googleProvider } from "./firebase";
import SalinasCardio from "./SalinasCardio";

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  if (user === undefined) {
    return <div style={styles.center}>Loading…</div>;
  }

  if (user === null) {
    return (
      <div style={styles.center}>
        <div style={styles.card}>
          <HeartPulse size={36} color="#5F9AB0" />
          <h1 style={styles.title}>Salinas Cardio</h1>
          <p style={styles.subtitle}>Cardiology teaching library</p>
          <button style={styles.signInBtn} onClick={() => signInWithPopup(auth, googleProvider)}>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return <SalinasCardio user={user} />;
}

const styles = {
  center: { minHeight: "100vh", display: "grid", placeItems: "center", background: "#12232C", fontFamily: "system-ui, sans-serif" },
  card: { background: "#fff", borderRadius: 16, padding: "36px 32px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, maxWidth: 320, textAlign: "center" },
  title: { fontSize: 24, margin: "10px 0 0", color: "#12232C" },
  subtitle: { fontSize: 14, color: "#6B7A85", margin: "0 0 20px" },
  signInBtn: { background: "#5F9AB0", border: "none", color: "#062028", padding: "11px 20px", borderRadius: 9, fontSize: 14.5, fontWeight: 600, cursor: "pointer" },
};
