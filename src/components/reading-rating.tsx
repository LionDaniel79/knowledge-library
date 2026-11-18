"use client";
export function RatingStars({ steps }: { steps: number | null | undefined }) {
  if (steps == null) return <span className="muted">미평가</span>;
  const count = Math.ceil(steps / 2);
  return (
    <span className="rating-display" aria-label={`${steps / 2}점`}>
      <span className="rating-glyphs" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className="rating-star">
            <span>★</span>
            <span
              className="rating-star-fill"
              style={{
                width: Math.min(1, Math.max(0, steps / 2 - i)) * 100 + "%",
              }}
            >
              ★
            </span>
          </span>
        ))}
      </span>
      <b>{(steps / 2).toFixed(1)}</b>
    </span>
  );
}
export function RatingInput({
  value,
  onChange,
  disabled = false,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="rating-input" disabled={disabled}>
      <legend>
        이 책의 별점 <small>선택 사항</small>
      </legend>
      <div
        className="rating-picker"
        role="radiogroup"
        aria-label="별점"
        onKeyDown={(e) => {
          if (
            ![
              "ArrowRight",
              "ArrowUp",
              "ArrowLeft",
              "ArrowDown",
              "Home",
              "End",
            ].includes(e.key)
          )
            return;
          const buttons = Array.from(
            e.currentTarget.querySelectorAll<HTMLButtonElement>(
              'button[role="radio"]',
            ),
          );
          const index = buttons.indexOf(e.target as HTMLButtonElement);
          if (index < 0) return;
          e.preventDefault();
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (index +
                    (e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1) +
                    buttons.length) %
                  buttons.length;
          buttons[next].focus();
          buttons[next].click();
        }}
      >
        <div className="rating-picker-stars">
          {[0, 1, 2, 3, 4].map((i) => (
            <span className="rating-choice-star" key={i}>
              <span className="rating-star">
                <span>★</span>
                <span
                  className="rating-star-fill"
                  style={{
                    width:
                      Math.min(1, Math.max(0, (value ?? 0) / 2 - i)) * 100 +
                      "%",
                  }}
                >
                  ★
                </span>
              </span>
              {[1, 2].map((half) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={value === i * 2 + half}
                  aria-label={`${(i * 2 + half) / 2}점`}
                  tabIndex={value === i * 2 + half ? 0 : -1}
                  key={half}
                  disabled={disabled}
                  onClick={() => onChange(i * 2 + half)}
                />
              ))}
            </span>
          ))}
        </div>
        <strong>{value == null ? "미평가" : (value / 2).toFixed(1)}</strong>
        <div className="rating-reset">
          <button
            type="button"
            role="radio"
            tabIndex={value === 0 ? 0 : -1}
            aria-checked={value === 0}
            disabled={disabled}
            onClick={() => onChange(0)}
          >
            0점
          </button>
          <button
            type="button"
            role="radio"
            tabIndex={value === null ? 0 : -1}
            aria-checked={value === null}
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            평가 안 함
          </button>
        </div>
      </div>
    </fieldset>
  );
}
