// Exercise the actual component's selection and callbacks with a minimal host/hook adapter.
// This does not claim to validate the native phone layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');

const compiled = ts.transpileModule(readFileSync(require.resolve('../client/main.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function fixture() {
  let selection = null;
  const jsx = (type, props) => ({ type, props });
  const module = { exports: {} };
  vm.runInNewContext(compiled, { exports: module.exports, Date, require(id) {
    if (id === 'react') return { useState: () => [selection, value => { selection = value; }] };
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === 'react-native') return { View: 'View', Text: 'Text', StyleSheet: { create: value => value } };
    return {};
  } });
  const used = [];
  const credits = { planType: 'pro', limitReached: false, availableCount: 3, credits:
    ['first', 'second', 'third'].map((id, i) => ({ id, expiresAt: Date.now() + (i + 1) * 3600000 })) };
  const props = { c: {}, credits, error: '', busy: false, onReset: id => used.push(id) };
  const render = () => module.exports.CodexCreditsInfo(props);
  const buttons = tree => {
    const result = [];
    const walk = n => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (n.type?.name === 'ActionButton') result.push(n.props);
      walk(n.props?.children);
    };
    walk(tree); return result;
  };
  return { props, credits, used, render, buttons };
}

test('未触顶时每张卡都有可用的 Reset，选择第三张只提交第三张', () => {
  const f = fixture(); const buttons = f.buttons(f.render());
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every(b => b.label === 'Reset' && !b.disabled));
  buttons[2].onPress();
  const confirm = f.buttons(f.render()).find(b => b.primary);
  assert.equal(confirm.label, 'Reset'); confirm.onPress();
  assert.deepEqual(f.used, ['third']);
});

test('选择第二张后列表重排，确认仍然使用原来选中的卡', () => {
  const f = fixture(); f.buttons(f.render())[1].onPress();
  f.credits.credits.reverse();
  f.buttons(f.render()).find(b => b.primary).onPress();
  assert.deepEqual(f.used, ['second']);
});

test('选中的卡刷新后消失或过期，不自动确认其他卡；取消允许重新选择', () => {
  const f = fixture(); f.buttons(f.render())[1].onPress();
  f.credits.credits = f.credits.credits.filter(c => c.id !== 'second');
  let buttons = f.buttons(f.render());
  assert.equal(buttons.find(b => b.primary).disabled, true);
  buttons.find(b => b.primary).onPress(); assert.deepEqual(f.used, []);
  buttons.find(b => b.label === '取消').onPress();
  f.buttons(f.render())[0].onPress();
  f.credits.credits[0].expiresAt = Date.now() - 1;
  buttons = f.buttons(f.render()); assert.equal(buttons.find(b => b.primary).disabled, true);
  buttons.find(b => b.primary).onPress(); assert.deepEqual(f.used, []);
});

test('提交期间所有 Reset 按钮禁用', () => {
  const f = fixture(); f.buttons(f.render())[0].onPress(); f.props.busy = true;
  assert.ok(f.buttons(f.render()).filter(b => b.label === 'Reset').every(b => b.disabled));
});
