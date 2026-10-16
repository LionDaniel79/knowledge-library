"use client";
import { useState } from "react";
import { Modal } from "./modal";
export function AssistHelp() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        사용법
      </button>
      {open && (
        <Modal title="AI 도움 사용법" onClose={() => setOpen(false)}>
          <ol>
            <li>기록을 먼저 저장합니다.</li>
            <li>
              도움 종류와 기록을 선택하고 ‘전송 내용 미리보기’를 누릅니다.
            </li>
            <li>보낼 글과 비용 상한을 확인한 뒤 요청합니다.</li>
            <li>결과를 읽고 필요한 제안만 채택합니다.</li>
          </ol>
          <details open>
            <summary>AI 정리와 결과 활용</summary>
            <p>
              AI 정리는 선택한 기록 한 개에서 태그·주제 후보를 최대 5개
              제안합니다. 각 후보의 근거를 확인하고 개별적으로 채택하세요.
              채택한 항목은 검색용 보조 정보가 됩니다. ‘사유의 지도’의 주제
              연결과 생각 변화 확정은 직접 판단합니다.
            </p>
            <p>
              태그 제안은 키워드만, 선택 구절 설명은 지정한 부분의 설명만
              제공합니다. 원문을 자동으로 고치거나 기록 전체를 일괄 전송하지
              않습니다. 입력 중인 초안은 먼저 저장하세요.
            </p>
          </details>
          <details>
            <summary>비용과 전송 범위</summary>
            <p>
              ChatGPT 구독과 OpenAI API 요금은 별도입니다. 요청당 상한과 월 상한
              안에서만 실행합니다. 실행 전에 선택한 글과 예상 비용 상한을 확인할
              수 있습니다. 사용량의 ‘예약’은 아직 비용 정산이 끝나지 않은 요청에
              확보한 금액입니다.
            </p>
            <p>
              API 응답이나 비용이 불확실하면 자동으로 재전송하지 않습니다.
              OpenAI 사용 내역에서 비용을 확인한 뒤 화면에 기록하세요. 사용법을
              여는 것과 미리보기에는 AI 호출 비용이 들지 않습니다.
            </p>
          </details>
          <details>
            <summary>AI 연결과 API 키</summary>
            <p>
              ‘온라인 AI 연결됨’이면 PC가 꺼져 있어도 웹 서버에서 요청을
              처리합니다. PC 연결 방식에서는 연결된 PC가 켜져 있어야 합니다.
              저장된 결과는 언제든 볼 수 있습니다.
            </p>
            <p>
              OpenAI API 키는 실행하는 서버 또는 PC의 비공개 설정에 보관합니다.
              ‘PC 연결 키’는 서재와 PC를 연결하는 별도의 키이며 90일간
              유효합니다. 이미 연결돼 있으면 새로 만들 필요가 없습니다. 키를
              새로 만들었다면 연결 파일을 PC 작업자에 설정해야 하며, 파일을
              내려받기만 해서는 연결되지 않습니다.
            </p>
          </details>
          <details>
            <summary>출처 표시와 생각 비교</summary>
            <p>
              ‘자료 구축 때 AI로 정리’는 초기 자료 정리에 AI가 쓰였다는
              출처입니다. 개발 대기 표시가 아닙니다. ‘AI 제안’은 요청해서 받은
              보조 정보이며, 근거와 이력은 필요할 때 펼쳐 볼 수 있습니다.
            </p>
            <p>
              두 기록의 생각 변화 비교는 정확도 검수 후 사용할 기능입니다.
              현재는 사유의 지도에서 기록의 시점·목소리·주제를 정하고 직접
              연결을 확정할 수 있습니다.
            </p>
          </details>
        </Modal>
      )}
    </>
  );
}
