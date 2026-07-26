import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  FileText, HeartPulse, Activity, Stethoscope, Syringe,
  Search, Upload, X, Play, Pause, Tag, User, Plus, MessageCircle,
  Columns, LayoutGrid, LogOut, ShieldCheck, Pencil, Trash2, HelpCircle, Pin, PinOff
} from "lucide-react";
import {
  collection, addDoc, onSnapshot, orderBy, query as fsQuery, serverTimestamp,
  doc, updateDoc, deleteDoc, setDoc, getDocs,
} from "firebase/firestore";
import { ref, uploadBytesResumable, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { signOut, signInWithPopup, sendSignInLinkToEmail } from "firebase/auth";
import { auth, db, storage, googleProvider } from "./firebase";

/* ============================================================
   SALINAS CARDIO — teaching library (v2, column board)
   ------------------------------------------------------------
   Two views:
     - Board  -> one column per content type (review at a glance)
     - Grid   -> unified feed (browse everything by recency)
   Each board column has its own quick-upload that pre-selects
   the right category, so "easy to upload" lands in the right lane.
   ============================================================ */

const CATEGORIES = [
  { id: "articles",   label: "PDF Articles",   icon: FileText,    accent: "#3B82A0", lane: "docs" },
  { id: "guidelines", label: "Guidelines",     icon: Stethoscope, accent: "#4E7C6B", lane: "docs" },
  { id: "procedures", label: "Procedures",     icon: Syringe,     accent: "#C08A2E", lane: "docs" },
  { id: "ekg",        label: "EKG Library",    icon: Activity,    accent: "#B4573A", lane: "ekg" },
  { id: "murmurs",    label: "Murmur Library", icon: HeartPulse,  accent: "#8A5A9E", lane: "murmurs" },
  { id: "questions",  label: "Q&A",            icon: HelpCircle,  accent: "#1F6F78", lane: "qanda" },
];

const LANES = [
  { id: "docs",    label: "Documents",       sub: "Articles · Guidelines · Procedures",  icon: FileText,   accent: "#3B82A0", defaultCat: "articles" },
  { id: "ekg",     label: "EKGs",            sub: "Tracings by pathology",               icon: Activity,   accent: "#B4573A", defaultCat: "ekg" },
  { id: "murmurs", label: "Heart Sounds",    sub: "Murmur audio library",                icon: HeartPulse, accent: "#8A5A9E", defaultCat: "murmurs" },
  { id: "qanda",   label: "Case Questions",  sub: "Questions & answers from providers",  icon: HelpCircle, accent: "#1F6F78", defaultCat: "questions" },
];

const catById   = (id) => CATEGORIES.find((c) => c.id === id);
const laneOfCat = (id) => catById(id)?.lane;

function youtubeId(url) {
  const m = (url || "").match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([\w-]{11})/);
  return m ? m[1] : null;
}

function getMedia(item) {
  if (item.media?.length) return item.media;
  if (item.fileUrl) return [{ url: item.fileUrl, storagePath: item.storagePath, type: "image" }];
  return [];
}

const WHATSAPP_LINK = "https://chat.whatsapp.com/your-group-invite";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB
const TAG_LIMIT = 10;

export default function SalinasCardio({ user }) {
  const [items, setItems] = useState([]);
  const [view, setView] = useState("board");
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState(null);
  const [upload, setUpload] = useState(null);
  const [playingId, setPlayingId] = useState(null);
  const [openItemId, setOpenItemId] = useState(null);
  const [signInPromptOpen, setSignInPromptOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [tagsExpanded, setTagsExpanded] = useState(false);

  const openUpload = (category) => {
    if (!user) { setSignInPromptOpen(true); return; }
    setUpload({ category });
  };

  useEffect(() => {
    if (!user?.email) { setIsAdmin(false); return; }
    const unsub = onSnapshot(doc(db, "admins", user.email.toLowerCase()), (snap) => setIsAdmin(snap.exists()));
    return unsub;
  }, [user]);

  useEffect(() => {
    const q = fsQuery(collection(db, "items"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now(),
        };
      }));
    });
    return unsub;
  }, []);

  const allTags = useMemo(() => {
    const t = new Set();
    items.forEach((i) => i.tags.forEach((x) => t.add(x)));
    return [...t].sort();
  }, [items]);

  const match = (i) => {
    if (activeTag && !i.tags.includes(activeTag)) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return i.title.toLowerCase().includes(q) || i.tags.some((t) => t.toLowerCase().includes(q))
      || (i.notes || "").toLowerCase().includes(q)
      || (i.question || "").toLowerCase().includes(q)
      || (i.answer || "").toLowerCase().includes(q);
  };

  const filtered = useMemo(
    () => items.filter(match).sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      return b.createdAt - a.createdAt;
    }),
    [items, query, activeTag]
  );

  const byLane = (lane) => filtered.filter((i) => laneOfCat(i.category) === lane);

  const addItem = async ({ file, fileUrl: providedUrl, mediaFiles, ...meta }, onProgress) => {
    let fileUrl = providedUrl || "";
    let storagePath = "";
    if (file) {
      storagePath = `${meta.category}/${Date.now()}-${file.name}`;
      const storageRef = ref(storage, storagePath);
      const task = uploadBytesResumable(storageRef, file);
      await new Promise((resolve, reject) => {
        task.on(
          "state_changed",
          (snap) => onProgress?.(snap.bytesTransferred / snap.totalBytes),
          reject,
          resolve
        );
      });
      fileUrl = await getDownloadURL(storageRef);
    }

    let media = [];
    if (mediaFiles && mediaFiles.length) {
      const totalBytes = mediaFiles.reduce((sum, f) => sum + f.size, 0);
      let doneBytes = 0;
      for (let i = 0; i < mediaFiles.length; i++) {
        const f = mediaFiles[i];
        const path = `${meta.category}/${Date.now()}-${i}-${f.name}`;
        const storageRef = ref(storage, path);
        const task = uploadBytesResumable(storageRef, f);
        await new Promise((resolve, reject) => {
          task.on(
            "state_changed",
            (snap) => onProgress?.((doneBytes + snap.bytesTransferred) / totalBytes),
            reject,
            () => { doneBytes += f.size; resolve(); }
          );
        });
        const url = await getDownloadURL(storageRef);
        media.push({ url, storagePath: path, type: f.type.startsWith("video/") ? "video" : "image" });
      }
    }

    await addDoc(collection(db, "items"), {
      ...meta,
      fileUrl,
      storagePath,
      ...(media.length ? { media } : {}),
      uploaderId: user.uid,
      createdAt: serverTimestamp(),
    });
  };

  return (
    <div style={S.app}>
      <style>{GLOBAL_CSS}</style>

      <header style={S.header}>
        <div style={S.headerInner}>
          <div>
            <div style={S.kicker}>Cardiology teaching library</div>
            <h1 style={S.title}>Salinas Cardio</h1>
          </div>
          <div style={S.headerActions}>
            <a href={WHATSAPP_LINK} target="_blank" rel="noreferrer" style={S.waBtn}>
              <MessageCircle size={16} /> Discussion
            </a>
            <button style={S.uploadBtn} onClick={() => openUpload("articles")}>
              <Plus size={16} /> Upload
            </button>
            {isAdmin && (
              <button style={S.signOutBtn} onClick={() => setAdminPanelOpen(true)} aria-label="Admin" title="Manage admins">
                <ShieldCheck size={16} />
              </button>
            )}
            {user ? (
              <button style={S.signOutBtn} onClick={() => signOut(auth)} aria-label="Sign out" title={`Signed in as ${user.displayName || user.email}`}>
                <LogOut size={16} />
              </button>
            ) : (
              <button style={S.signInBtn} onClick={() => setSignInPromptOpen(true)}>
                Sign in
              </button>
            )}
          </div>
        </div>

        <div style={S.controls}>
          <div style={S.searchWrap}>
            <Search size={18} color="#7B8794" />
            <input style={S.search} placeholder="Search titles, pathologies, notes..." value={query} onChange={(e) => setQuery(e.target.value)} />
            {query && <button style={S.clearBtn} onClick={() => setQuery("")}><X size={15} /></button>}
          </div>
          <div style={S.viewToggle}>
            <button style={{ ...S.viewBtn, ...(view === "board" ? S.viewBtnActive : {}) }} onClick={() => setView("board")}>
              <Columns size={15} /> Board
            </button>
            <button style={{ ...S.viewBtn, ...(view === "grid" ? S.viewBtnActive : {}) }} onClick={() => setView("grid")}>
              <LayoutGrid size={15} /> Grid
            </button>
          </div>
        </div>
      </header>

      {allTags.length > 0 && (
        <div style={S.tagRow}>
          <Tag size={14} color="#7B8794" />
          {(tagsExpanded ? allTags : allTags.slice(0, TAG_LIMIT)).map((t) => (
            <button key={t} onClick={() => setActiveTag(activeTag === t ? null : t)}
              style={{ ...S.tagPill, ...(activeTag === t ? S.tagPillActive : {}) }}>{t}</button>
          ))}
          {allTags.length > TAG_LIMIT && (
            <button style={S.tagMoreBtn} onClick={() => setTagsExpanded((v) => !v)}>
              {tagsExpanded ? "Show less" : `+${allTags.length - TAG_LIMIT} more`}
            </button>
          )}
          {activeTag && <button style={S.tagClear} onClick={() => setActiveTag(null)}>clear x</button>}
        </div>
      )}

      {view === "board" ? (
        <div className="board" style={S.board}>
          {LANES.map((lane) => {
            const laneItems = byLane(lane.id);
            const Icon = lane.icon;
            return (
              <section key={lane.id} style={S.column}>
                <div style={{ ...S.colHead, borderTopColor: lane.accent }}>
                  <div style={S.colHeadTop}>
                    <div style={S.colTitleWrap}>
                      <span style={{ ...S.colIcon, background: `${lane.accent}18` }}><Icon size={16} color={lane.accent} /></span>
                      <div>
                        <h2 style={S.colTitle}>{lane.label}</h2>
                        <div style={S.colSub}>{lane.sub}</div>
                      </div>
                    </div>
                    <span style={S.colCount}>{laneItems.length}</span>
                  </div>
                  <button style={{ ...S.colAdd, color: lane.accent, borderColor: `${lane.accent}55` }}
                    onClick={() => openUpload(lane.defaultCat)}>
                    <Plus size={14} /> Add
                  </button>
                </div>
                <div className="colBody" style={S.colBody}>
                  {laneItems.length === 0 ? (
                    <div style={S.colEmpty}>Nothing here yet.</div>
                  ) : (
                    laneItems.map((item) => (
                      <ColumnItem key={item.id} item={item}
                        playing={playingId === item.id}
                        onPlay={() => setPlayingId(playingId === item.id ? null : item.id)}
                        onTag={setActiveTag}
                        onOpen={() => setOpenItemId(item.id)} />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <main style={S.grid}>
          {filtered.length === 0 ? (
            <div style={S.gridEmpty}>Nothing matches. Try clearing the search or a tag.</div>
          ) : (
            filtered.map((item) => (
              <GridCard key={item.id} item={item}
                playing={playingId === item.id}
                onPlay={() => setPlayingId(playingId === item.id ? null : item.id)}
                onTag={setActiveTag}
                onOpen={() => setOpenItemId(item.id)} />
            ))
          )}
        </main>
      )}

      {upload && <UploadModal initialCategory={upload.category} onClose={() => setUpload(null)} onAdd={addItem} />}
      {openItemId && (
        <DetailModal
          item={items.find((i) => i.id === openItemId) || null}
          user={user}
          isAdmin={isAdmin}
          onRequestSignIn={() => setSignInPromptOpen(true)}
          onClose={() => setOpenItemId(null)}
          onTag={setActiveTag}
        />
      )}
      {signInPromptOpen && <SignInModal onClose={() => setSignInPromptOpen(false)} />}
      {adminPanelOpen && <AdminPanel user={user} onClose={() => setAdminPanelOpen(false)} />}
    </div>
  );
}

function ColumnItem({ item, playing, onPlay, onTag, onOpen }) {
  const cat = catById(item.category);
  const Icon = cat.icon;
  const ytId = item.fileType === "youtube" ? youtubeId(item.fileUrl) : null;
  const media = item.category === "questions" ? getMedia(item) : [];
  return (
    <article style={S.rowCard}>
      {item.category === "ekg" ? (
        item.fileUrl
          ? <div style={S.rowEkg}><img src={item.fileUrl} alt={item.title} style={S.thumbImg} /></div>
          : <div style={S.rowEkg}><EkgPreview color={cat.accent} /></div>
      ) : item.fileType === "youtube" ? (
        <button
          style={{ ...S.rowThumb, background: `${cat.accent}14`, backgroundImage: ytId ? `url(https://img.youtube.com/vi/${ytId}/default.jpg)` : undefined, backgroundSize: "cover", backgroundPosition: "center" }}
          onClick={onPlay} aria-label="Play heart sound video"
        >
          <span style={{ ...S.playMini, background: cat.accent }}>
            {playing ? <Pause size={15} color="#fff" /> : <Play size={15} color="#fff" style={{ marginLeft: 1 }} />}
          </span>
        </button>
      ) : item.fileType === "audio" ? (
        <button style={{ ...S.rowThumb, background: `${cat.accent}14` }} onClick={onPlay} aria-label="Play murmur">
          <span style={{ ...S.playMini, background: cat.accent }}>
            {playing ? <Pause size={15} color="#fff" /> : <Play size={15} color="#fff" style={{ marginLeft: 1 }} />}
          </span>
        </button>
      ) : item.category === "questions" ? (
        media.length > 0 ? (
          <div style={S.rowEkg}>
            {media[0].type === "video"
              ? <video style={S.thumbImg} src={media[0].url} muted preload="metadata" />
              : <img src={media[0].url} alt={item.title} style={S.thumbImg} />}
            {media.length > 1 && <span style={S.mediaBadge}>+{media.length - 1}</span>}
          </div>
        ) : (
          <div style={{ ...S.rowThumb, background: `${cat.accent}14` }}><Icon size={20} color={cat.accent} strokeWidth={1.6} /></div>
        )
      ) : (
        <a href={item.fileUrl} target="_blank" rel="noreferrer" style={{ ...S.rowThumb, background: `${cat.accent}14` }}>
          <Icon size={20} color={cat.accent} strokeWidth={1.6} />
        </a>
      )}
      <div style={S.rowMain}>
        <h3 style={{ ...S.rowTitle, cursor: "pointer" }} onClick={onOpen}>
          {item.pinned && <Pin size={12} color="#C08A2E" style={{ verticalAlign: -1, marginRight: 4 }} />}
          {item.title}
        </h3>
        {item.category === "questions"
          ? (item.question && <p style={S.rowNotes}>{item.question}</p>)
          : (item.notes && <p style={S.rowNotes}>{item.notes}</p>)}
        <div style={S.rowTags}>
          {item.tags.map((t) => <button key={t} style={S.miniTag} onClick={() => onTag(t)}>{t}</button>)}
        </div>
        <div style={S.rowMeta}>
          <User size={11} color="#93A1AC" /> {item.uploaderName} · {timeAgo(item.createdAt)}
          <button style={S.discussBtn} onClick={onOpen}><MessageCircle size={11} /> Discuss</button>
        </div>
        {playing && ytId && (
          <div style={S.ytEmbedRow}>
            <iframe
              width="100%" height="160" style={S.ytIframe}
              src={`https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1`}
              title={item.title} allow="autoplay; encrypted-media" allowFullScreen
            />
          </div>
        )}
      </div>
      {playing && item.fileType === "audio" && <audio src={item.fileUrl} autoPlay onEnded={onPlay} style={{ display: "none" }} />}
    </article>
  );
}

function GridCard({ item, playing, onPlay, onTag, onOpen }) {
  const cat = catById(item.category);
  const Icon = cat.icon;
  const ytId = item.fileType === "youtube" ? youtubeId(item.fileUrl) : null;
  const media = item.category === "questions" ? getMedia(item) : [];
  return (
    <article style={S.card}>
      <div style={{ ...S.cardTop, background: `${cat.accent}0F`, ...(item.fileType === "youtube" && playing ? S.cardTopExpanded : {}) }}>
        {item.category === "ekg"
          ? (item.fileUrl ? <img src={item.fileUrl} alt={item.title} style={S.cardImg} /> : <EkgPreview color={cat.accent} />)
          : item.fileType === "youtube" ? (
            playing && ytId ? (
              <iframe
                style={S.ytIframe}
                src={`https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1`}
                title={item.title} allow="autoplay; encrypted-media" allowFullScreen
              />
            ) : (
              <button style={S.ytThumbBtn} onClick={onPlay} aria-label="Play heart sound video">
                {ytId && <img src={`https://img.youtube.com/vi/${ytId}/hqdefault.jpg`} alt="" style={S.cardImg} />}
                <span style={{ ...S.playCircleOverlay, background: cat.accent }}>
                  <Play size={22} color="#fff" style={{ marginLeft: 2 }} />
                </span>
              </button>
            )
          ) : item.fileType === "audio" ? (
            <button style={S.audioBtn} onClick={onPlay} aria-label="Play murmur">
              <span style={{ ...S.playCircle, background: cat.accent }}>
                {playing ? <Pause size={22} color="#fff" /> : <Play size={22} color="#fff" style={{ marginLeft: 2 }} />}
              </span>
              {playing && <Waveform color={cat.accent} />}
            </button>
          ) : item.category === "questions" ? (
            media.length > 0 ? (
              <>
                {media[0].type === "video"
                  ? <video style={S.cardImg} src={media[0].url} muted preload="metadata" />
                  : <img src={media[0].url} alt={item.title} style={S.cardImg} />}
                {media.length > 1 && <span style={S.mediaBadgeCard}>+{media.length - 1}</span>}
              </>
            ) : (
              <div style={S.docPreview}><Icon size={34} color={cat.accent} strokeWidth={1.5} /></div>
            )
          ) : (
            <a href={item.fileUrl} target="_blank" rel="noreferrer" style={S.docPreview}>
              <Icon size={34} color={cat.accent} strokeWidth={1.5} />
            </a>
          )}
        <span style={{ ...S.catTag, color: cat.accent, borderColor: `${cat.accent}44` }}>{cat.label}</span>
      </div>
      <div style={S.cardBody}>
        <h3 style={{ ...S.cardTitle, cursor: "pointer" }} onClick={onOpen}>
          {item.pinned && <Pin size={12} color="#C08A2E" style={{ verticalAlign: -1, marginRight: 4 }} />}
          {item.title}
        </h3>
        {item.category === "questions"
          ? (item.question && <p style={S.cardNotes}>{item.question}</p>)
          : (item.notes && <p style={S.cardNotes}>{item.notes}</p>)}
        <div style={S.cardTags}>{item.tags.map((t) => <button key={t} style={S.miniTag} onClick={() => onTag(t)}>{t}</button>)}</div>
        <div style={S.cardMeta}>
          <User size={12} color="#93A1AC" /> {item.uploaderName}<span style={S.metaDot}>·</span>{timeAgo(item.createdAt)}
          <button style={S.discussBtnCard} onClick={onOpen}><MessageCircle size={12} /> Discuss</button>
        </div>
      </div>
      {playing && item.fileType === "audio" && <audio src={item.fileUrl} autoPlay onEnded={onPlay} style={{ display: "none" }} />}
    </article>
  );
}

function EkgPreview({ color }) {
  return (
    <svg viewBox="0 0 200 70" style={{ width: "100%", height: "100%" }} preserveAspectRatio="none">
      <path d="M0,40 L20,40 L24,40 L26,30 L28,52 L30,10 L32,55 L34,40 L60,40 L64,40 L66,32 L68,50 L70,14 L72,53 L74,40 L100,40 L104,40 L106,30 L108,52 L110,10 L112,55 L114,40 L140,40 L144,40 L146,32 L148,50 L150,14 L152,53 L154,40 L200,40"
        fill="none" stroke={color} strokeWidth="1.6" opacity="0.85" />
    </svg>
  );
}
function Waveform({ color }) {
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "center", marginLeft: 14 }}>
      {[10, 22, 14, 26, 12, 20, 16].map((h, i) => (
        <span key={i} className="wf-bar" style={{ height: h, background: color, animationDelay: `${i * 0.08}s` }} />
      ))}
    </div>
  );
}

function UploadModal({ initialCategory, onClose, onAdd }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(initialCategory || "articles");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [uploader, setUploader] = useState("");
  const [file, setFile] = useState(null);
  const [mediaFiles, setMediaFiles] = useState([]);
  const [fileError, setFileError] = useState("");
  const [progress, setProgress] = useState(null); // null = idle, 0-1 while uploading
  const [sourceMode, setSourceMode] = useState("file"); // "file" | "youtube" | "link" (murmurs only)
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [audioLinkUrl, setAudioLinkUrl] = useState("");
  const fileRef = useRef();
  const mediaRef = useRef();

  const isYoutube = category === "murmurs" && sourceMode === "youtube";
  const isAudioLink = category === "murmurs" && sourceMode === "link";
  const isQuestions = category === "questions";

  const onFileChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) { setFile(null); return; }
    if (f.size > MAX_FILE_BYTES) {
      setFileError(`File is too large (max ${MAX_FILE_BYTES / (1024 * 1024)}MB).`);
      setFile(null);
      e.target.value = "";
      return;
    }
    setFileError("");
    setFile(f);
  };

  const onMediaFilesChange = (e) => {
    const picked = Array.from(e.target.files || []);
    const oversized = picked.filter((f) => f.size > MAX_FILE_BYTES);
    setFileError(oversized.length ? `${oversized.length} file(s) skipped — over ${MAX_FILE_BYTES / (1024 * 1024)}MB limit.` : "");
    setMediaFiles((prev) => [...prev, ...picked.filter((f) => f.size <= MAX_FILE_BYTES)]);
    e.target.value = "";
  };

  const removeMediaFile = (index) => setMediaFiles((prev) => prev.filter((_, i) => i !== index));

  const submit = async () => {
    if (!title.trim() || !uploader.trim() || progress !== null) return;
    if (isYoutube && !youtubeId(youtubeUrl.trim())) {
      setFileError("Enter a valid YouTube link.");
      return;
    }
    if (isAudioLink && !/^https?:\/\//.test(audioLinkUrl.trim())) {
      setFileError("Enter a valid audio link (starting with http:// or https://).");
      return;
    }
    if (isQuestions && (!question.trim() || !answer.trim())) {
      setFileError("Enter both a question and an answer.");
      return;
    }
    const fileType = isYoutube ? "youtube"
      : category === "murmurs" ? "audio"
      : category === "ekg" ? "image"
      : isQuestions ? ""
      : "pdf";
    setProgress(0);
    try {
      await onAdd(
        {
          file: isYoutube || isAudioLink || isQuestions ? null : file,
          fileUrl: isYoutube ? youtubeUrl.trim() : isAudioLink ? audioLinkUrl.trim() : undefined,
          mediaFiles: isQuestions ? mediaFiles : undefined,
          title: title.trim(), category,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          notes: notes.trim(), uploaderName: uploader.trim(), fileType,
          ...(isQuestions ? { question: question.trim(), answer: answer.trim() } : {}),
        },
        setProgress
      );
      onClose();
    } catch (err) {
      setFileError(err.message || "Upload failed. Please try again.");
      setProgress(null);
    }
  };

  const busy = progress !== null;

  return (
    <div style={S.overlay} onClick={busy ? undefined : onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <h2 style={S.modalTitle}>Add to the library</h2>
          <button style={S.closeBtn} onClick={onClose} disabled={busy}><X size={18} /></button>
        </div>
        <label style={S.field}>
          <span style={S.fieldLabel}>Category</span>
          <select style={S.input} value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy}>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label style={S.field}>
          <span style={S.fieldLabel}>Title</span>
          <input style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Inferior STEMI with reciprocal changes" disabled={busy} />
        </label>
        <label style={S.field}>
          <span style={S.fieldLabel}>Pathology tags <span style={S.hint}>comma-separated</span></span>
          <input style={S.input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="STEMI, ischemia, inferior" disabled={busy} />
        </label>
        {isQuestions ? (
          <>
            <label style={S.field}>
              <span style={S.fieldLabel}>Question</span>
              <textarea style={{ ...S.input, minHeight: 70, resize: "vertical" }} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What the provider asked..." disabled={busy} />
            </label>
            <label style={S.field}>
              <span style={S.fieldLabel}>Answer</span>
              <textarea style={{ ...S.input, minHeight: 70, resize: "vertical" }} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="The correct answer / explanation" disabled={busy} />
            </label>
          </>
        ) : (
          <label style={S.field}>
            <span style={S.fieldLabel}>Teaching note <span style={S.hint}>optional</span></span>
            <textarea style={{ ...S.input, minHeight: 60, resize: "vertical" }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What should the intern notice?" disabled={busy} />
          </label>
        )}
        <label style={S.field}>
          <span style={S.fieldLabel}>Your name</span>
          <input style={S.input} value={uploader} onChange={(e) => setUploader(e.target.value)} placeholder="Dr. Salinas / intern name" disabled={busy} />
        </label>
        {category === "murmurs" && (
          <div style={S.sourceToggle}>
            <button type="button" style={{ ...S.sourceToggleBtn, ...(sourceMode === "file" ? S.sourceToggleBtnActive : {}) }} onClick={() => setSourceMode("file")} disabled={busy}>Upload file</button>
            <button type="button" style={{ ...S.sourceToggleBtn, ...(sourceMode === "youtube" ? S.sourceToggleBtnActive : {}) }} onClick={() => setSourceMode("youtube")} disabled={busy}>YouTube link</button>
            <button type="button" style={{ ...S.sourceToggleBtn, ...(sourceMode === "link" ? S.sourceToggleBtnActive : {}) }} onClick={() => setSourceMode("link")} disabled={busy}>Audio link</button>
          </div>
        )}
        {isYoutube ? (
          <label style={S.field}>
            <span style={S.fieldLabel}>YouTube link</span>
            <input style={S.input} value={youtubeUrl} onChange={(e) => setYoutubeUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..." disabled={busy} />
          </label>
        ) : isAudioLink ? (
          <label style={S.field}>
            <span style={S.fieldLabel}>Audio link <span style={S.hint}>direct link to an mp3/wav file</span></span>
            <input style={S.input} value={audioLinkUrl} onChange={(e) => setAudioLinkUrl(e.target.value)} placeholder="https://example.edu/audio/murmur.mp3" disabled={busy} />
          </label>
        ) : isQuestions ? (
          <>
            <div style={{ ...S.dropzone, opacity: busy ? 0.6 : 1 }} onClick={() => !busy && mediaRef.current?.click()}>
              <Upload size={18} color="#5A6B78" />
              <span>Attach images or videos (optional, multiple allowed)</span>
              <input ref={mediaRef} type="file" accept="image/*,video/*" multiple style={{ display: "none" }} onChange={onMediaFilesChange} disabled={busy} />
            </div>
            {mediaFiles.length > 0 && (
              <div style={S.mediaFileList}>
                {mediaFiles.map((f, i) => (
                  <div key={i} style={S.mediaFileRow}>
                    <span>{f.name}</span>
                    <button type="button" style={S.discussBtn} onClick={() => removeMediaFile(i)} disabled={busy}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ ...S.dropzone, opacity: busy ? 0.6 : 1 }} onClick={() => !busy && fileRef.current?.click()}>
            <Upload size={18} color="#5A6B78" />
            <span>{file?.name || "Choose file (PDF, image, or audio)"}</span>
            <input ref={fileRef} type="file" style={{ display: "none" }} onChange={onFileChange} disabled={busy} />
          </div>
        )}
        {fileError && <div style={S.errorText}>{fileError}</div>}
        {busy && (
          <div style={S.progressTrack}>
            <div style={{ ...S.progressFill, width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <button style={{ ...S.uploadBtn, width: "100%", justifyContent: "center", marginTop: 8, opacity: title.trim() && uploader.trim() && (!isQuestions || (question.trim() && answer.trim())) && !busy ? 1 : 0.5 }} onClick={submit} disabled={busy}>
          {busy ? `Uploading… ${Math.round(progress * 100)}%` : "Add to library"}
        </button>
      </div>
    </div>
  );
}

function DetailModal({ item, user, isAdmin, onRequestSignIn, onClose, onTag }) {
  const [comments, setComments] = useState([]);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [editExistingMedia, setEditExistingMedia] = useState([]);
  const [editNewMediaFiles, setEditNewMediaFiles] = useState([]);
  const editMediaRef = useRef();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!item) return;
    const q = fsQuery(collection(db, "items", item.id, "comments"), orderBy("createdAt", "asc"));
    const unsub = onSnapshot(q, (snap) => {
      setComments(snap.docs.map((d) => {
        const data = d.data();
        return { id: d.id, ...data, createdAt: data.createdAt?.toMillis ? data.createdAt.toMillis() : Date.now() };
      }));
    });
    return unsub;
  }, [item?.id]);

  if (!item) return null;
  const cat = catById(item.category);
  const ytId = item.fileType === "youtube" ? youtubeId(item.fileUrl) : null;
  const media = item.category === "questions" ? getMedia(item) : [];

  const postComment = async () => {
    if (!text.trim() || posting || !user) return;
    setPosting(true);
    try {
      await addDoc(collection(db, "items", item.id, "comments"), {
        text: text.trim(),
        authorName: user.displayName || user.email,
        authorId: user.uid,
        createdAt: serverTimestamp(),
      });
      setText("");
    } finally {
      setPosting(false);
    }
  };

  const removeComment = async (commentId) => {
    await deleteDoc(doc(db, "items", item.id, "comments", commentId));
  };

  const startEdit = () => {
    setEditTitle(item.title);
    setEditCategory(item.category);
    setEditTags(item.tags.join(", "));
    setEditNotes(item.notes || "");
    setEditQuestion(item.question || "");
    setEditAnswer(item.answer || "");
    setEditExistingMedia(media);
    setEditNewMediaFiles([]);
    setEditing(true);
  };

  const onEditMediaFilesChange = (e) => {
    const picked = Array.from(e.target.files || []);
    setEditNewMediaFiles((prev) => [...prev, ...picked.filter((f) => f.size <= MAX_FILE_BYTES)]);
    e.target.value = "";
  };

  const saveEdit = async () => {
    if (!editTitle.trim() || saving) return;
    const editIsQuestions = editCategory === "questions";
    setSaving(true);
    try {
      let finalMedia;
      if (editIsQuestions) {
        const keptPaths = new Set(editExistingMedia.map((m) => m.storagePath).filter(Boolean));
        const removed = media.filter((m) => m.storagePath && !keptPaths.has(m.storagePath));
        for (const m of removed) {
          try { await deleteObject(ref(storage, m.storagePath)); } catch { /* already gone */ }
        }
        const uploadedNew = [];
        for (let i = 0; i < editNewMediaFiles.length; i++) {
          const f = editNewMediaFiles[i];
          const path = `${editCategory}/${Date.now()}-${i}-${f.name}`;
          const storageRef = ref(storage, path);
          await uploadBytes(storageRef, f);
          const url = await getDownloadURL(storageRef);
          uploadedNew.push({ url, storagePath: path, type: f.type.startsWith("video/") ? "video" : "image" });
        }
        finalMedia = [...editExistingMedia, ...uploadedNew];
      }
      await updateDoc(doc(db, "items", item.id), {
        title: editTitle.trim(),
        category: editCategory,
        tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
        notes: editNotes.trim(),
        ...(editIsQuestions ? { question: editQuestion.trim(), answer: editAnswer.trim(), media: finalMedia } : {}),
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const deleteItem = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      if (item.storagePath) {
        try { await deleteObject(ref(storage, item.storagePath)); } catch { /* file already gone */ }
      }
      await deleteDoc(doc(db, "items", item.id));
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  const togglePin = async () => {
    if (pinning) return;
    setPinning(true);
    try {
      await updateDoc(doc(db, "items", item.id), { pinned: !item.pinned });
    } finally {
      setPinning(false);
    }
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.detailModal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          {editing ? (
            <input style={{ ...S.input, fontSize: 18, fontWeight: 600 }} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
          ) : (
            <h2 style={S.modalTitle}>{item.title}</h2>
          )}
          <button style={S.closeBtn} onClick={onClose}><X size={18} /></button>
        </div>

        <div style={S.detailMetaRow}>
          <span style={{ ...S.catTag, position: "static", color: cat.accent, borderColor: `${cat.accent}44` }}>{cat.label}</span>
          <span style={S.rowMeta}><User size={12} color="#93A1AC" /> {item.uploaderName} · {timeAgo(item.createdAt)}</span>
          {isAdmin && !editing && (
            <div style={S.adminActions}>
              <button style={S.discussBtn} onClick={togglePin} disabled={pinning}>
                {item.pinned ? <PinOff size={12} /> : <Pin size={12} />} {item.pinned ? "Unpin" : "Pin"}
              </button>
              <button style={S.discussBtn} onClick={startEdit}><Pencil size={12} /> Edit</button>
              <button style={{ ...S.discussBtn, color: "#B4573A" }} onClick={() => setConfirmingDelete(true)}><Trash2 size={12} /> Delete</button>
            </div>
          )}
        </div>

        {confirmingDelete && (
          <div style={S.deleteConfirm}>
            <span>Delete this item permanently?</span>
            <button style={{ ...S.discussBtn, color: "#B4573A", fontWeight: 700 }} onClick={deleteItem} disabled={deleting}>
              {deleting ? "Deleting…" : "Yes, delete"}
            </button>
            <button style={S.discussBtn} onClick={() => setConfirmingDelete(false)}>Cancel</button>
          </div>
        )}

        {editing ? (
          <>
            <label style={S.field}>
              <span style={S.fieldLabel}>Category</span>
              <select style={S.input} value={editCategory} onChange={(e) => setEditCategory(e.target.value)}>
                {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
            <label style={S.field}>
              <span style={S.fieldLabel}>Pathology tags <span style={S.hint}>comma-separated</span></span>
              <input style={S.input} value={editTags} onChange={(e) => setEditTags(e.target.value)} />
            </label>
            {editCategory === "questions" ? (
              <>
                <label style={S.field}>
                  <span style={S.fieldLabel}>Question</span>
                  <textarea style={{ ...S.input, minHeight: 60, resize: "vertical" }} value={editQuestion} onChange={(e) => setEditQuestion(e.target.value)} />
                </label>
                <label style={S.field}>
                  <span style={S.fieldLabel}>Answer</span>
                  <textarea style={{ ...S.input, minHeight: 60, resize: "vertical" }} value={editAnswer} onChange={(e) => setEditAnswer(e.target.value)} />
                </label>
                {editExistingMedia.length > 0 && (
                  <div style={S.mediaFileList}>
                    {editExistingMedia.map((m, i) => (
                      <div key={i} style={S.mediaFileRow}>
                        <span>{m.type === "video" ? "Video" : "Image"} {i + 1}</span>
                        <button type="button" style={S.discussBtn} onClick={() => setEditExistingMedia((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
                {editNewMediaFiles.length > 0 && (
                  <div style={S.mediaFileList}>
                    {editNewMediaFiles.map((f, i) => (
                      <div key={i} style={S.mediaFileRow}>
                        <span>{f.name}</span>
                        <button type="button" style={S.discussBtn} onClick={() => setEditNewMediaFiles((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ ...S.dropzone, marginBottom: 13 }} onClick={() => editMediaRef.current?.click()}>
                  <Upload size={18} color="#5A6B78" />
                  <span>Add more images or videos</span>
                  <input ref={editMediaRef} type="file" accept="image/*,video/*" multiple style={{ display: "none" }} onChange={onEditMediaFilesChange} />
                </div>
              </>
            ) : (
              <label style={S.field}>
                <span style={S.fieldLabel}>Teaching note</span>
                <textarea style={{ ...S.input, minHeight: 60, resize: "vertical" }} value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
              </label>
            )}
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button style={{ ...S.uploadBtn, flex: 1, justifyContent: "center" }} onClick={saveEdit} disabled={saving || !editTitle.trim()}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              <button style={{ ...S.sourceToggleBtn, flex: 1 }} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </>
        ) : item.category === "questions" ? (
          <>
            <div style={S.qaLabel}>Question</div>
            <p style={S.detailNotes}>{item.question}</p>
            {media.length > 0 && (
              <div style={S.detailMedia}>
                {media.map((m, i) => (
                  m.type === "video"
                    ? <video key={i} src={m.url} controls style={{ ...S.detailImg, marginBottom: i < media.length - 1 ? 10 : 0 }} />
                    : <img key={i} src={m.url} alt={item.title} style={{ ...S.detailImg, marginBottom: i < media.length - 1 ? 10 : 0 }} />
                ))}
              </div>
            )}
            <div style={S.qaLabel}>Answer</div>
            <p style={S.detailNotes}>{item.answer}</p>
            <div style={S.rowTags}>
              {item.tags.map((t) => <button key={t} style={S.miniTag} onClick={() => { onTag(t); onClose(); }}>{t}</button>)}
            </div>
          </>
        ) : (
          <>
            <div style={S.detailMedia}>
              {item.category === "ekg" && item.fileUrl && <img src={item.fileUrl} alt={item.title} style={S.detailImg} />}
              {item.fileType === "audio" && <audio src={item.fileUrl} controls style={{ width: "100%" }} />}
              {item.fileType === "youtube" && ytId && (
                <iframe
                  style={S.detailYtIframe}
                  src={`https://www.youtube-nocookie.com/embed/${ytId}`}
                  title={item.title} allow="autoplay; encrypted-media" allowFullScreen
                />
              )}
              {item.fileType === "pdf" && item.fileUrl && (
                <a href={item.fileUrl} target="_blank" rel="noreferrer" style={S.detailPdfLink}>
                  <FileText size={18} /> Open document
                </a>
              )}
            </div>

            {item.notes && <p style={S.detailNotes}>{item.notes}</p>}
            <div style={S.rowTags}>
              {item.tags.map((t) => <button key={t} style={S.miniTag} onClick={() => { onTag(t); onClose(); }}>{t}</button>)}
            </div>
          </>
        )}

        <div style={S.commentsSection}>
          <h3 style={S.commentsHeading}>Discussion</h3>
          {comments.length === 0 && <div style={S.colEmpty}>No comments yet — be the first to add a clarification.</div>}
          {comments.map((c) => (
            <div key={c.id} style={S.commentRow}>
              <div style={S.commentMeta}>
                <strong>{c.authorName}</strong> · {timeAgo(c.createdAt)}
                {isAdmin && <button style={S.discussBtn} onClick={() => removeComment(c.id)}>Remove</button>}
              </div>
              <div style={S.commentText}>{c.text}</div>
            </div>
          ))}
          {user ? (
            <div style={S.commentInputRow}>
              <textarea
                style={{ ...S.input, minHeight: 50, resize: "vertical" }}
                value={text} onChange={(e) => setText(e.target.value)}
                placeholder="Add a comment or clarification..."
              />
              <button style={{ ...S.uploadBtn, alignSelf: "flex-end", opacity: text.trim() && !posting ? 1 : 0.5 }} onClick={postComment} disabled={posting || !text.trim()}>
                {posting ? "Posting…" : "Post"}
              </button>
            </div>
          ) : (
            <button style={{ ...S.uploadBtn, width: "100%", justifyContent: "center", marginTop: 8 }} onClick={onRequestSignIn}>
              Sign in to comment
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SignInModal({ onClose }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const withGoogle = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
      onClose();
    } catch {
      // user closed/cancelled the popup
    }
  };

  const sendLink = async () => {
    if (!email.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      await sendSignInLinkToEmail(auth, email.trim(), {
        url: window.location.href,
        handleCodeInApp: true,
      });
      window.localStorage.setItem("emailForSignIn", email.trim());
      setSent(true);
    } catch (err) {
      setError(err.message || "Couldn't send the link. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <h2 style={S.modalTitle}>Sign in</h2>
          <button style={S.closeBtn} onClick={onClose}><X size={18} /></button>
        </div>
        <button style={{ ...S.uploadBtn, width: "100%", justifyContent: "center" }} onClick={withGoogle}>
          Continue with Google
        </button>
        <div style={S.signInDivider}>or</div>
        {sent ? (
          <div style={S.colEmpty}>Check <strong>{email}</strong> for a sign-in link.</div>
        ) : (
          <>
            <label style={S.field}>
              <span style={S.fieldLabel}>Institutional or personal email</span>
              <input style={S.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@utrgv.edu" disabled={sending} />
            </label>
            {error && <div style={S.errorText}>{error}</div>}
            <button
              style={{ ...S.sourceToggleBtn, width: "100%", background: "#12232C", color: "#fff", borderColor: "#12232C", opacity: email.trim() && !sending ? 1 : 0.5 }}
              onClick={sendLink} disabled={sending || !email.trim()}
            >
              {sending ? "Sending…" : "Email me a sign-in link"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AdminPanel({ user, onClose }) {
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getDocs(collection(db, "admins"))
      .then((snap) => setAdmins(snap.docs.map((d) => ({ id: d.id, ...d.data() }))))
      .finally(() => setLoading(false));
  }, []);

  const addAdmin = async () => {
    const normalized = email.trim().toLowerCase();
    if (!normalized || busy) return;
    setBusy(true);
    setError("");
    try {
      await setDoc(doc(db, "admins", normalized), {
        email: normalized,
        addedBy: user.email,
        addedAt: serverTimestamp(),
      });
      setAdmins((prev) => prev.some((a) => a.id === normalized) ? prev : [...prev, { id: normalized, email: normalized }]);
      setEmail("");
    } catch (err) {
      setError(err.message || "Couldn't add admin.");
    } finally {
      setBusy(false);
    }
  };

  const removeAdmin = async (id) => {
    if (id === user.email.toLowerCase()) return; // don't let someone remove themselves
    await deleteDoc(doc(db, "admins", id));
    setAdmins((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <h2 style={S.modalTitle}>Admins</h2>
          <button style={S.closeBtn} onClick={onClose}><X size={18} /></button>
        </div>
        <label style={S.field}>
          <span style={S.fieldLabel}>Add an admin by email</span>
          <input style={S.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@utrgv.edu" disabled={busy} />
        </label>
        {error && <div style={S.errorText}>{error}</div>}
        <button
          style={{ ...S.uploadBtn, width: "100%", justifyContent: "center", marginBottom: 16, opacity: email.trim() && !busy ? 1 : 0.5 }}
          onClick={addAdmin} disabled={busy || !email.trim()}
        >
          Add admin
        </button>
        <div style={S.commentsHeading}>Current admins</div>
        {loading ? (
          <div style={S.colEmpty}>Loading…</div>
        ) : (
          admins.map((a) => (
            <div key={a.id} style={S.adminRow}>
              <span>{a.email}</span>
              {a.id !== user.email.toLowerCase() && (
                <button style={S.discussBtn} onClick={() => removeAdmin(a.id)}>Remove</button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function timeAgo(ts) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

const S = {
  app: { minHeight: "100vh", background: "#F5F6F4", color: "#12232C", fontFamily: "'Inter', system-ui, sans-serif", paddingBottom: 60 },
  header: { background: "#12232C", padding: "22px 20px 18px", position: "sticky", top: 0, zIndex: 20 },
  headerInner: { maxWidth: 1240, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap" },
  kicker: { fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "#5F9AB0", fontWeight: 600 },
  title: { fontFamily: "'Fraunces', Georgia, serif", fontSize: 34, fontWeight: 600, color: "#fff", margin: "2px 0 0", letterSpacing: "-0.01em" },
  headerActions: { display: "flex", gap: 10, alignItems: "center" },
  waBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "transparent", border: "1px solid #2E4A57", color: "#CFE0E7", padding: "9px 14px", borderRadius: 9, fontSize: 14, fontWeight: 500, cursor: "pointer", textDecoration: "none" },
  uploadBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "#5F9AB0", border: "none", color: "#062028", padding: "9px 15px", borderRadius: 9, fontSize: 14, fontWeight: 600, cursor: "pointer" },
  signOutBtn: { display: "inline-flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "1px solid #2E4A57", color: "#CFE0E7", width: 38, height: 38, borderRadius: 9, cursor: "pointer" },
  signInBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "transparent", border: "1px solid #2E4A57", color: "#CFE0E7", padding: "9px 14px", borderRadius: 9, fontSize: 14, fontWeight: 500, cursor: "pointer" },
  controls: { maxWidth: 1240, margin: "16px auto 0", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" },
  searchWrap: { flex: 1, minWidth: 220, background: "#fff", borderRadius: 11, padding: "0 14px", display: "flex", alignItems: "center", gap: 10, height: 46 },
  search: { flex: 1, border: "none", outline: "none", fontSize: 15, background: "transparent", color: "#12232C" },
  clearBtn: { border: "none", background: "#EEF1F0", borderRadius: 6, width: 24, height: 24, display: "grid", placeItems: "center", cursor: "pointer", color: "#5A6B78" },
  viewToggle: { display: "flex", background: "#0B1A22", borderRadius: 10, padding: 3, gap: 2 },
  viewBtn: { display: "inline-flex", alignItems: "center", gap: 6, border: "none", background: "transparent", color: "#7E97A3", padding: "8px 14px", borderRadius: 8, fontSize: 13.5, fontWeight: 500, cursor: "pointer" },
  viewBtnActive: { background: "#5F9AB0", color: "#062028", fontWeight: 600 },
  tagRow: { maxWidth: 1240, margin: "14px auto 0", padding: "0 20px", display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" },
  tagPill: { fontSize: 12, padding: "5px 11px", borderRadius: 999, border: "1px solid #DDE3E1", background: "#fff", color: "#5A6B78", cursor: "pointer", fontWeight: 500 },
  tagPillActive: { background: "#12232C", color: "#fff", borderColor: "#12232C" },
  tagClear: { fontSize: 12, background: "none", border: "none", color: "#93A1AC", cursor: "pointer" },
  tagMoreBtn: { fontSize: 12, padding: "5px 11px", borderRadius: 999, border: "1px dashed #C8D2CE", background: "transparent", color: "#5A6B78", cursor: "pointer", fontWeight: 600 },

  board: { maxWidth: 1240, margin: "20px auto 0", padding: "0 20px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, alignItems: "start" },
  column: { background: "#EFF1EF", borderRadius: 14, overflow: "hidden", border: "1px solid #E4E8E5" },
  colHead: { background: "#fff", borderTop: "3px solid", padding: "14px 15px 12px" },
  colHeadTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  colTitleWrap: { display: "flex", gap: 10, alignItems: "center" },
  colIcon: { width: 32, height: 32, borderRadius: 9, display: "grid", placeItems: "center" },
  colTitle: { fontSize: 15.5, fontWeight: 700, margin: 0, color: "#12232C" },
  colSub: { fontSize: 11.5, color: "#8494A0", marginTop: 1 },
  colCount: { fontSize: 12, background: "#F0F3F1", color: "#5A6B78", borderRadius: 999, padding: "2px 9px", fontWeight: 700 },
  colAdd: { display: "inline-flex", alignItems: "center", gap: 5, marginTop: 11, background: "#fff", borderWidth: 1, borderStyle: "dashed", borderRadius: 8, padding: "7px 11px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", width: "100%", justifyContent: "center" },
  colBody: { padding: 10, display: "flex", flexDirection: "column", gap: 10, maxHeight: 620, overflowY: "auto" },
  colEmpty: { textAlign: "center", color: "#93A1AC", fontSize: 13, padding: "24px 0" },

  rowCard: { background: "#fff", borderRadius: 11, border: "1px solid #EAEDEB", padding: 10, display: "flex", gap: 11 },
  rowThumb: { width: 52, height: 52, borderRadius: 9, flexShrink: 0, display: "grid", placeItems: "center", border: "none", cursor: "pointer" },
  rowEkg: { width: 52, height: 52, borderRadius: 9, flexShrink: 0, background: "#FBF3F0", overflow: "hidden", display: "grid", placeItems: "center", position: "relative" },
  mediaBadge: { position: "absolute", bottom: 2, right: 2, background: "rgba(18,35,44,.8)", color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 5, padding: "1px 4px", lineHeight: 1.4 },
  mediaBadgeCard: { position: "absolute", bottom: 8, right: 8, background: "rgba(18,35,44,.75)", color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: 6, padding: "2px 7px" },
  thumbImg: { width: "100%", height: "100%", objectFit: "cover" },
  playMini: { width: 30, height: 30, borderRadius: 999, display: "grid", placeItems: "center" },
  rowMain: { minWidth: 0, flex: 1 },
  rowTitle: { fontSize: 14, fontWeight: 600, margin: 0, lineHeight: 1.3, color: "#12232C" },
  rowNotes: { fontSize: 12, color: "#6B7A85", margin: "4px 0 0", lineHeight: 1.4 },
  rowTags: { display: "flex", gap: 5, flexWrap: "wrap", margin: "8px 0 0" },
  rowMeta: { fontSize: 11, color: "#93A1AC", marginTop: 8, display: "flex", alignItems: "center", gap: 4 },
  discussBtn: { display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "none", color: "#8A5A9E", fontSize: 11, fontWeight: 600, cursor: "pointer", marginLeft: "auto", padding: 0 },
  ytEmbedRow: { marginTop: 10 },
  ytIframe: { width: "100%", height: "100%", border: "none", borderRadius: 8 },

  grid: { maxWidth: 1240, margin: "22px auto 0", padding: "0 20px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 18 },
  gridEmpty: { gridColumn: "1/-1", textAlign: "center", padding: "60px 20px", color: "#7B8794", fontSize: 15 },
  card: { background: "#fff", borderRadius: 14, overflow: "hidden", border: "1px solid #EAEDEB", display: "flex", flexDirection: "column" },
  cardTop: { position: "relative", height: 92, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", transition: "height 0.15s ease" },
  cardTopExpanded: { height: 190 },
  cardImg: { width: "100%", height: "100%", objectFit: "cover" },
  ytThumbBtn: { position: "relative", width: "100%", height: "100%", border: "none", padding: 0, cursor: "pointer", background: "none" },
  playCircleOverlay: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 44, height: 44, borderRadius: 999, display: "grid", placeItems: "center", boxShadow: "0 2px 8px rgba(0,0,0,.25)" },
  catTag: { position: "absolute", top: 10, right: 10, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", background: "#fff", border: "1px solid", borderRadius: 6, padding: "3px 7px" },
  docPreview: { display: "grid", placeItems: "center", width: "100%", height: "100%" },
  audioBtn: { display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", width: "100%", height: "100%" },
  playCircle: { width: 44, height: 44, borderRadius: 999, display: "grid", placeItems: "center", boxShadow: "0 2px 8px rgba(0,0,0,.15)" },
  cardBody: { padding: "13px 15px 15px" },
  cardTitle: { fontSize: 15.5, fontWeight: 600, margin: 0, lineHeight: 1.3 },
  cardNotes: { fontSize: 13, color: "#5A6B78", margin: "6px 0 0", lineHeight: 1.45 },
  cardTags: { display: "flex", gap: 6, flexWrap: "wrap", margin: "11px 0 0" },
  cardMeta: { display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "#93A1AC", marginTop: 12 },
  discussBtnCard: { display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "none", color: "#8A5A9E", fontSize: 11.5, fontWeight: 600, cursor: "pointer", marginLeft: "auto", padding: 0 },
  metaDot: { margin: "0 2px" },
  miniTag: { fontSize: 11, background: "#F0F3F1", border: "none", color: "#4E6270", borderRadius: 5, padding: "3px 8px", cursor: "pointer", fontWeight: 500 },

  overlay: { position: "fixed", inset: 0, background: "rgba(10,20,26,.55)", display: "grid", placeItems: "center", padding: 20, zIndex: 50, backdropFilter: "blur(2px)" },
  modal: { background: "#fff", borderRadius: 16, padding: 22, width: "100%", maxWidth: 440, maxHeight: "90vh", overflowY: "auto" },
  modalHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  modalTitle: { fontFamily: "'Fraunces', Georgia, serif", fontSize: 21, margin: 0, fontWeight: 600 },
  closeBtn: { border: "none", background: "#F0F3F1", width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", cursor: "pointer", color: "#5A6B78" },
  field: { display: "block", marginBottom: 13 },
  fieldLabel: { display: "block", fontSize: 12.5, fontWeight: 600, color: "#3A4A54", marginBottom: 5 },
  hint: { fontWeight: 400, color: "#93A1AC" },
  input: { width: "100%", border: "1px solid #DDE3E1", borderRadius: 9, padding: "10px 12px", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit", color: "#12232C" },
  dropzone: { display: "flex", alignItems: "center", gap: 9, border: "1.5px dashed #C8D2CE", borderRadius: 10, padding: "14px", color: "#5A6B78", fontSize: 13.5, cursor: "pointer", marginTop: 4 },
  sourceToggle: { display: "flex", gap: 6, marginBottom: 10 },
  sourceToggleBtn: { flex: 1, border: "1px solid #DDE3E1", background: "#fff", color: "#5A6B78", borderRadius: 8, padding: "8px 10px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  sourceToggleBtnActive: { background: "#12232C", color: "#fff", borderColor: "#12232C" },
  mediaFileList: { display: "flex", flexDirection: "column", gap: 4, marginTop: 8 },
  mediaFileRow: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, color: "#3A4A54", background: "#F0F3F1", borderRadius: 7, padding: "6px 10px" },
  signInDivider: { textAlign: "center", color: "#93A1AC", fontSize: 12, margin: "14px 0" },
  adminRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #F0F3F1", fontSize: 13.5, color: "#12232C" },
  errorText: { color: "#B4573A", fontSize: 12.5, marginTop: 6 },
  progressTrack: { height: 6, background: "#EEF1F0", borderRadius: 999, marginTop: 12, overflow: "hidden" },
  progressFill: { height: "100%", background: "#5F9AB0", transition: "width 0.15s linear" },

  detailModal: { background: "#fff", borderRadius: 16, padding: 24, width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto" },
  detailMetaRow: { display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" },
  adminActions: { display: "flex", gap: 12, marginLeft: "auto" },
  deleteConfirm: { display: "flex", alignItems: "center", gap: 10, background: "#FBF3F0", border: "1px solid #F0DCD4", borderRadius: 9, padding: "10px 12px", fontSize: 13, color: "#7A3A28", marginBottom: 14 },
  detailMedia: { marginBottom: 14 },
  detailImg: { width: "100%", borderRadius: 10, display: "block" },
  detailYtIframe: { width: "100%", height: 280, border: "none", borderRadius: 10 },
  detailPdfLink: { display: "inline-flex", alignItems: "center", gap: 8, background: "#F0F3F1", color: "#12232C", borderRadius: 9, padding: "10px 14px", fontSize: 14, fontWeight: 600, textDecoration: "none" },
  detailNotes: { fontSize: 14, color: "#3A4A54", lineHeight: 1.5, margin: "0 0 10px" },
  qaLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "#1F6F78", margin: "0 0 4px" },

  commentsSection: { marginTop: 20, paddingTop: 16, borderTop: "1px solid #EAEDEB" },
  commentsHeading: { fontSize: 14, fontWeight: 700, margin: "0 0 10px", color: "#12232C" },
  commentRow: { padding: "8px 0", borderBottom: "1px solid #F0F3F1" },
  commentMeta: { fontSize: 12, color: "#7B8794", marginBottom: 3, display: "flex", alignItems: "center", gap: 10 },
  commentText: { fontSize: 13.5, color: "#12232C", lineHeight: 1.45, whiteSpace: "pre-wrap" },
  commentInputRow: { display: "flex", flexDirection: "column", gap: 8, marginTop: 12 },
};

const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap');
* { box-sizing: border-box; }
body { margin: 0; }
.wf-bar { width: 3px; border-radius: 2px; animation: wf 0.7s ease-in-out infinite alternate; }
@keyframes wf { to { transform: scaleY(0.4); } }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #5F9AB0; outline-offset: 2px; }
.colBody::-webkit-scrollbar { width: 6px; }
.colBody::-webkit-scrollbar-thumb { background: #D4DAD6; border-radius: 3px; }
@media (max-width: 900px) {
  .wf-bar { display: none; }
  .board { grid-template-columns: 1fr !important; }
}
`;
