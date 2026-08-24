잉톡 공개 약관 사이트 배포 안내

1. 이 폴더 안의 파일을 기존 웹서버의 /ingtalk/ 폴더에 업로드합니다.
2. 서버가 UTF-8, Classic ASP, 서버측 include를 지원하는지 확인합니다.
3. 업로드 후 아래 주소를 휴대전화와 PC에서 확인합니다.
   https://itembus.com/ingtalk/
   https://itembus.com/ingtalk/terms.asp
   https://itembus.com/ingtalk/privacy.asp
   https://itembus.com/ingtalk/deletion.asp
   https://itembus.com/ingtalk/support.asp
   https://itembus.com/ingtalk/community.asp
   https://itembus.com/ingtalk/child-safety
4. 각 페이지가 로그인 없이 열리고 HTTPS 인증서 오류가 없어야 합니다.
5. store/STORE_LISTING_KO.md에 반영된 URL을 App Store Connect와 Google Play Console에 입력합니다.

Google Play 데이터 보안 입력 URL
- 계정 URL 삭제: https://www.itembus.com/ingtalk/deletion.asp
- 데이터 URL 삭제: https://www.itembus.com/ingtalk/deletion.asp
- 아동 안전 표준 URL: https://www.itembus.com/ingtalk/child-safety

필수 업로드 파일
default.asp, index.asp, terms.asp, privacy.asp, deletion.asp, support.asp, community.asp,
child-safety/default.asp, _header.asp, _footer.asp, styles.css

default.asp는 /ingtalk/ 폴더 주소로 접속했을 때 index.asp로 이동시키는 기본 문서입니다.

언어 선택
- 모든 페이지 상단에서 한국어와 English를 선택할 수 있습니다.
- 선택 언어는 URL의 ?lang=ko 또는 ?lang=en과 보안 쿠키에 저장됩니다.
- Google Play 영문 링크 예: https://www.itembus.com/ingtalk/deletion.asp?lang=en
