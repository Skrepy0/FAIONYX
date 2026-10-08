import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { backgroundImageEffect, carouselImages, MAX_CAROUSEL_IMAGES } from '../src/shared/appearancePolicy'

test('image alpha and blur have independent mappings including zero blur and fully transparent', () => {
  for (const blur of [0, 12, 40]) {
    const a = backgroundImageEffect({ opacity: 1, blur })
    const b = backgroundImageEffect({ opacity: 0.05, blur })
    assert.equal(a.filter, b.filter)
    assert.notEqual(a.opacity, b.opacity)
  }
  assert.equal(backgroundImageEffect({ opacity: 0, blur: 0 }).filter, 'none')
  assert.equal(backgroundImageEffect({ opacity: 0, blur: 30 }).opacity, '0')
  const app = fs.readFileSync('src/renderer/src/App.vue', 'utf8')
  const shell = app.match(/\.shell.has-bg\s*\{([^}]*)\}/)![1]
  assert(!shell.includes('backdrop-filter'))
})
test('carousel migrates single image, preserves ordering, deduplicates and bounds count', () => {
  assert.deepEqual(carouselImages({ image: 'old.png' }), ['old.png'])
  assert.deepEqual(carouselImages({ image: 'old.png', images: [] }), [])
  const persisted = JSON.parse(JSON.stringify({ image: 'a', images: ['b', 'a', 'b', ''] }))
  assert.deepEqual(carouselImages(persisted), ['b', 'a'])
  assert.equal(carouselImages({ images: Array.from({ length: 100 }, (_, i) => String(i)) }).length, MAX_CAROUSEL_IMAGES)
})
test('appearance editor and real carousel compile; import uses native multi-file selection', () => {
  for (const file of ['components/HomeLayoutEditor.vue', 'views/HomeView.vue', 'App.vue']) {
    const { descriptor, errors } = parse(fs.readFileSync('src/renderer/src/' + file, 'utf8'))
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: file })
    assert.deepEqual(
      compileTemplate({
        source: descriptor.template!.content,
        filename: file,
        id: file,
        compilerOptions: { bindingMetadata: script.bindings },
      }).errors,
      []
    )
  }
  assert.match(fs.readFileSync('src/main/ipc.ts', 'utf8'), /multiSelections/)
  assert.match(fs.readFileSync('src/main/nativeAppearance.ts', 'utf8'), /!appliedMaterial.has\(window\)/)
})
