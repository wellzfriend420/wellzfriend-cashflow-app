/**
 * 日本の祝日・営業日判定
 *
 * 現行の祝日法に基づく定例祝日、振替休日、国民の休日を計算する。
 * 2020年・2021年の特例移動にも対応する。春分・秋分の計算対象は1980〜2099年。
 * 法改正や臨時祝日が発表された場合は、このファイルだけを更新する。
 */

const JAPAN_HOLIDAY_CACHE = {};

/** 土日祝日でなければtrue */
function isBusinessDay(date) {
  const day = date.getDay();
  return day !== 0 && day !== 6 && !isJapaneseHoliday(date);
}

/** 日本の祝日ならtrue */
function isJapaneseHoliday(date) {
  const holidays = getJapaneseHolidays(date.getFullYear());
  return !!holidays[formatDateKey(date)];
}

/**
 * 休日調整
 * rule: next=翌営業日 / previous=前営業日 / none=当日
 */
function adjustToBusinessDay(date, rule) {
  const adjusted = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (rule === 'none' || isBusinessDay(adjusted)) return adjusted;

  const direction = rule === 'previous' ? -1 : 1;
  for (let i = 0; i < 20 && !isBusinessDay(adjusted); i++) {
    adjusted.setDate(adjusted.getDate() + direction);
  }
  return adjusted;
}

/** 指定年月の日付を作成。31日指定などはその月の末日に丸める。 */
function createClampedDate(year, month, day) {
  const lastDay = new Date(year, month, 0).getDate();
  return new Date(year, month - 1, Math.min(Number(day), lastDay));
}

/** YYYY-MM-DD */
function formatDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

/** 年ごとの祝日マップを返す */
function getJapaneseHolidays(year) {
  if (JAPAN_HOLIDAY_CACHE[year]) return JAPAN_HOLIDAY_CACHE[year];

  const holidays = {};
  const add = (month, day, name) => {
    holidays[
      year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0')
    ] = name;
  };

  add(1, 1, '元日');
  add(1, nthWeekdayOfMonth(year, 1, 1, 2), '成人の日');
  add(2, 11, '建国記念の日');
  if (year >= 2020) add(2, 23, '天皇誕生日');

  const vernal = getVernalEquinoxDay(year);
  if (vernal) add(3, vernal, '春分の日');

  add(4, 29, '昭和の日');
  add(5, 3, '憲法記念日');
  add(5, 4, 'みどりの日');
  add(5, 5, 'こどもの日');

  if (year === 2020) {
    add(7, 23, '海の日');
    add(7, 24, 'スポーツの日');
    add(8, 10, '山の日');
  } else if (year === 2021) {
    add(7, 22, '海の日');
    add(7, 23, 'スポーツの日');
    add(8, 8, '山の日');
  } else {
    add(7, nthWeekdayOfMonth(year, 7, 1, 3), '海の日');
    if (year >= 2016) add(8, 11, '山の日');
    add(10, nthWeekdayOfMonth(year, 10, 1, 2), 'スポーツの日');
  }

  add(9, nthWeekdayOfMonth(year, 9, 1, 3), '敬老の日');
  const autumnal = getAutumnalEquinoxDay(year);
  if (autumnal) add(9, autumnal, '秋分の日');
  add(11, 3, '文化の日');
  add(11, 23, '勤労感謝の日');

  // 国民の休日：祝日に挟まれた日
  const first = new Date(year, 0, 2);
  const last = new Date(year, 11, 30);
  for (let date = first; date <= last; date.setDate(date.getDate() + 1)) {
    const key = formatDateKey(date);
    if (holidays[key]) continue;
    const prev = new Date(date);
    const next = new Date(date);
    prev.setDate(prev.getDate() - 1);
    next.setDate(next.getDate() + 1);
    if (holidays[formatDateKey(prev)] && holidays[formatDateKey(next)]) {
      holidays[key] = '国民の休日';
    }
  }

  // 振替休日：日曜の祝日後、最初の祝日でない日
  Object.keys(holidays).sort().forEach(key => {
    const parts = key.split('-').map(Number);
    const holiday = new Date(parts[0], parts[1] - 1, parts[2]);
    if (holiday.getDay() !== 0) return;
    const substitute = new Date(holiday);
    do {
      substitute.setDate(substitute.getDate() + 1);
    } while (holidays[formatDateKey(substitute)]);
    holidays[formatDateKey(substitute)] = '振替休日';
  });

  JAPAN_HOLIDAY_CACHE[year] = holidays;
  return holidays;
}

/** 指定月の第n月曜日等を返す。weekday: 日=0、月=1... */
function nthWeekdayOfMonth(year, month, weekday, nth) {
  const first = new Date(year, month - 1, 1);
  return 1 + ((7 + weekday - first.getDay()) % 7) + (nth - 1) * 7;
}

function getVernalEquinoxDay(year) {
  if (year < 1980 || year > 2099) return null;
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

function getAutumnalEquinoxDay(year) {
  if (year < 1980 || year > 2099) return null;
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}
