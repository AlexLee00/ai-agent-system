// cycle #53 M2: Tailwind JIT 설정
// content paths: LiveView가 사용하는 모든 HEEx 파일 스캔
module.exports = {
  content: [
    "../lib/team_jay/dashboard/**/*.{ex,heex}",
    "../lib/team_jay/dashboard/live/**/*.ex",
    "../lib/team_jay_web/**/*.{ex,heex}"
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
