/**
 * 最小的具名占位插值：把文案里的 {name} 换成 params 里对应的值。
 * 不引第三方库——这个规模用不上 i18next/formatjs，真到需要复数规则的
 * 时候再点名引入不迟。
 *
 * 用法：
 *   // 词条（auth 域）：passwordTooShort: '密码长度要在 {min} 到 {max} 之间'
 *   format(text.passwordTooShort, {min: 6, max: 128})
 *   // → '密码长度要在 6 到 128 之间'
 *
 * params 里没给的占位符原样留着（不报错、也不会替换成 'undefined'）。
 * 不带占位符的词条是普通字符串，直接用，不必经过这里。
 */

/**
 * 提取模板串里 {xxx} 占位符的名字，用来约束 params 的键：模板是字符串
 * 字面量时（比如 format('…{min}…', …)），参数键写错或缺键都是编译错误，
 * 编辑器也能补全；词条值的类型是普通 string 时提取不出名字，params
 * 退化成宽松的 Record<string, string | number>，照常可用。
 */
type Placeholder<T extends string> = T extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholder<Rest>
  : never;

export function format<T extends string>(
  template: T,
  params: Record<Placeholder<T>, string | number> & Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}
