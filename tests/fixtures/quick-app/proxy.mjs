import { label } from './assets/module.mjs'
const dynamic = await import('./assets/dynamic.mjs')
const data = await fetch('./data.json?version=1').then(response => response.json())
const unicode = await fetch('./空 格.txt?version=1').then(response => response.text())
await document.fonts.load('16px FixtureFont')
await document.querySelector('#picture').decode()
document.querySelector('#result').textContent = [label, dynamic.value, data.value, unicode.trim(), window.classicValue].join('|')
window.fixtureReady = true
