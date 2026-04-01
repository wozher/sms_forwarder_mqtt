/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './public/index.html',
    './public/src/**/*.js'
  ],
  theme: {
    extend: {
      colors: {
        primary: { 50: '#eff6ff', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' },
        dark: { bg: '#0f172a', card: '#1e293b', border: '#334155' }
      }
    }
  },
  safelist: [
    // Classes used in JS templates and conditional rendering
    { pattern: /^(bg|text|border)-(green|red|blue|slate|amber|teal)-(50|100|200|400|500|600|900)$/ },
    { pattern: /^(from|to)-(blue|teal|green|slate)-(50|100|200|400|500|600|900)$/ },
    { pattern: /^(hover:)?(bg|text|border)-(green|red|blue|slate|amber|teal)-(50|100|200|400|500|600|900)$/ }
  ],
  plugins: []
};
