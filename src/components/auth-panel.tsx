"use client";
import { useState } from "react";
import { BookOpen, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
export function AuthPanel({
  available,
  message,
  returnPath = "/",
}: {
  available: boolean;
  message?: string;
  returnPath?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(message ?? "");
  async function signInWithGoogle() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL:
          window.location.origin +
          (returnPath.startsWith("/connect/mcp?") ? returnPath : "/"),
        errorCallbackURL: window.location.origin + "/auth/sign-in?login=failed",
      });
      if (result.error)
        throw Error("Google에 연결하지 못했습니다. 다시 시도해 주세요.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Google 로그인에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-story">
        <div className="brand">
          <BookOpen />
          <strong>문장과 사유</strong>
        </div>
        <span className="eyebrow">A HOME FOR YOUR READING LIFE</span>
        <h1>
          읽은 책은 남고,
          <br />
          생각은 이어집니다.
        </h1>
        <p>
          책 한 권, 마음에 남은 문장, 아직 답하지 못한 질문.
          <br />
          평생의 독서를 위한 나만의 지식 서재.
        </p>
        <div className="abstract-books">
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="auth-card">
        <span className="eyebrow">MY PRIVATE LIBRARY</span>
        <h2>나의 서재 열기</h2>
        <p className="muted">
          Google 계정으로 간편하게 시작하세요. 별도의 비밀번호나 이메일
          인증번호를 입력할 필요가 없습니다.
        </p>
        {!available ? (
          <div className="notice">
            온라인 서재의 연결 설정이 필요합니다. 예시 화면을 먼저 살펴보세요.
          </div>
        ) : (
          <div className="editor-form">
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button
              className="primary wide"
              disabled={busy}
              onClick={signInWithGoogle}
            >
              <span aria-hidden="true">G</span>
              {busy ? "Google에 연결하는 중…" : "Google 계정으로 시작하기"}
            </button>
            <p className="form-hint">
              서재 주인으로 등록된 Google 계정을 선택해 주세요. 처음 연결하면
              서재 계정이 자동으로 만들어집니다.
            </p>
          </div>
        )}
        <div className="auth-foot">
          <ShieldCheck size={17} />
          <span>책과 기록은 로그인한 나에게만 보입니다.</span>
        </div>
        <a href="/preview" className="preview-link">
          예시 서재 먼저 둘러보기 →
        </a>
      </div>
    </main>
  );
}
