import React, { useState, useEffect, useRef } from 'react';
import {
  Bell, PlusCircle, MapPin, HardHat, Wallet,
  RefreshCw, CheckCircle2, CreditCard, UserPlus, X, Loader2,
  LifeBuoy, ChevronRight, Home, Package, User, Users, Eye, FileText,
  Phone, MessageCircle, Clock, Server, Coffee, LogIn, LogOut, Printer,
  Pencil, Trash2, Lock, ShieldCheck, Search, Share2, Heart
} from 'lucide-react';

const API_BASE = 'https://factory-backend-production-7cde.up.railway.app';

// প্রিন্ট করা যায় এমন যেকোনো কনটেন্ট PDF বানিয়ে হোয়াটসঅ্যাপ/অন্য অ্যাপে শেয়ার করার জন্য
const loadExternalScript = (src) => new Promise((resolve, reject) => {
  if (document.querySelector(`script[src="${src}"]`)) return resolve();
  const script = document.createElement('script');
  script.src = src;
  script.onload = resolve;
  script.onerror = reject;
  document.body.appendChild(script);
});

// ==== ছবি-ভিত্তিক PDF — বর্তমানে এটাই মূল পদ্ধতি (বাংলা টেক্সট PDF জটিল যুক্তাক্ষর ঠিকভাবে দেখাতে পারে না) ====
// idealY-এর কাছাকাছি একটা "ফাঁকা" (সাদা/ব্যাকগ্রাউন্ড রঙের) অনুভূমিক লাইন খুঁজে বের করে,
// যাতে ঠিক সেখানে পাতা কাটলে কোনো লেখার লাইনের মাঝখান দিয়ে কাটা না পড়ে
const findSafeCutLine = (canvas, idealY, maxSearchUp, options = {}) => {
  const { denseCheckLeftPx = 0 } = typeof options === 'number' ? { denseCheckLeftPx: 0 } : options;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const searchStart = Math.max(0, idealY - maxSearchUp);
  const searchHeight = idealY - searchStart;
  if (searchHeight <= 0) return idealY;

  const imgData = ctx.getImageData(0, searchStart, width, searchHeight).data;
  let bestRow = searchHeight - 1;
  let bestScore = -1;

  // idealY-এর কাছ থেকে শুরু করে উপরের দিকে খুঁজবে — সবচেয়ে হালকা (সাদা/হালকা ধূসর দাগ) লাইনটাই
  // সবচেয়ে নিরাপদ কাটার জায়গা, তা সম্পূর্ণ সাদা না হলেও (যেমন এন্ট্রির মাঝের হালকা ধূসর বর্ডার লাইন)।
  // denseCheckLeftPx দেওয়া থাকলে বাম পাশের সরু বর্ডার-স্ট্রিপ অংশটুকু প্রতি পিক্সেল ঘন করে আলাদা চেক
  // করা হয় (শুধু every-6th-pixel না) — নাহলে কম স্কেলে পাতলা স্ট্রিপটা সহজেই এড়িয়ে যাওয়ার ঝুঁকি থাকে
  for (let row = searchHeight - 1; row >= 0; row--) {
    const rowOffset = row * width * 4;
    let minChannel = 255;
    for (let x = 0; x < width; x += 6) {
      const idx = rowOffset + x * 4;
      const darkest = Math.min(imgData[idx], imgData[idx + 1], imgData[idx + 2]);
      if (darkest < minChannel) minChannel = darkest;
    }
    if (denseCheckLeftPx > 0) {
      for (let x = 0; x < denseCheckLeftPx; x++) {
        const idx = rowOffset + x * 4;
        const darkest = Math.min(imgData[idx], imgData[idx + 1], imgData[idx + 2]);
        if (darkest < minChannel) minChannel = darkest;
      }
    }
    if (minChannel > bestScore) {
      bestScore = minChannel;
      bestRow = row;
    }
    if (minChannel >= 250) break; // প্রায় সম্পূর্ণ সাদা লাইন পেয়ে গেলে আর খোঁজার দরকার নেই
  }

  return searchStart + bestRow;
};

const shareContentAsImagePDF = async (elementId, filename, title, options = {}) => {
  const { denseCheckLeftPx = 0, cutBoundarySelector = null, pageFormat = 'a4' } = options;
  await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
  await loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');

  const element = document.getElementById(elementId);
  if (!element) throw new Error('কনটেন্ট পাওয়া যায়নি');

  // cutBoundarySelector দেওয়া থাকলে — অনুমান-নির্ভর পিক্সেল স্ক্যানিং না করে, DOM থেকে সরাসরি প্রতিটা
  // এন্ট্রির আসল উপরে/নিচের অবস্থান মেপে সেই দুটোর মাঝের ফাঁকা জায়গাকেই "নিরাপদ কাটার জায়গা" ধরা হচ্ছে —
  // এটা পিক্সেল-রঙ অনুমানের চেয়ে অনেক বেশি নির্ভরযোগ্য
  let domSafeCutPoints = [];
  if (cutBoundarySelector) {
    const items = Array.from(element.querySelectorAll(cutBoundarySelector));
    const elementTop = element.getBoundingClientRect().top;
    for (let i = 0; i < items.length - 1; i++) {
      const currentBottom = items[i].getBoundingClientRect().bottom - elementTop;
      const nextTop = items[i + 1].getBoundingClientRect().top - elementTop;
      if (nextTop > currentBottom) {
        domSafeCutPoints.push((currentBottom + nextTop) / 2); // দুটো এন্ট্রির ঠিক মাঝখানে
      }
    }
  }

  // উচ্চ রেজুলেশন অগ্রাধিকার — শুধু সত্যিই অস্বাভাবিক লম্বা কনটেন্টেই (যা ব্রাউজারের ক্যানভাস সীমা
  // ছুঁয়ে ফেলতে পারে) রেজুলেশন কমবে, নাহলে সবসময় সর্বোচ্চ মানেই থাকবে
  const MAX_SAFE_CANVAS_HEIGHT = 24000;
  const elementHeightPx = element.scrollHeight || element.offsetHeight || 1000;
  const idealScale = 3;
  const scale = Math.max(1, Math.min(idealScale, MAX_SAFE_CANVAS_HEIGHT / elementHeightPx));

  const captureOptions = {
    scale,
    backgroundColor: '#ffffff',
    onclone: (clonedDoc) => {
      // প্রিন্টের সময় যেসব বাটন/আইকন লুকানো থাকে (print:hidden ক্লাস), সেগুলো স্ক্রিনশট থেকেও বাদ দেওয়া হচ্ছে
      clonedDoc.querySelectorAll('.print\\:hidden').forEach((el) => {
        el.style.display = 'none';
      });
    }
  };

  let canvas;
  let actualScale = scale;
  try {
    canvas = await window.html2canvas(element, captureOptions);
  } catch (err) {
    // এত বড় যে প্রথম চেষ্টাতেও ব্যর্থ হলে, রেজুলেশন কিছুটা কমিয়ে শেষ চেষ্টা করা হচ্ছে —
    // যাতে কনটেন্ট যত বড়ই হোক, শেয়ার করাটা সম্পূর্ণ ব্যর্থ না হয়
    console.error('স্বাভাবিক রেজুলেশনে ক্যাপচার ব্যর্থ হয়েছে, কম রেজুলেশনে আবার চেষ্টা করা হচ্ছে:', err.message);
    actualScale = 1;
    canvas = await window.html2canvas(element, { ...captureOptions, scale: 1 });
  }

  // DOM-এ মাপা ফাঁকা জায়গাগুলো এখন ক্যানভাসের আসল পিক্সেল স্কেলে রূপান্তর করা হচ্ছে
  const domSafeCutPointsPx = domSafeCutPoints.map((p) => p * actualScale);

  const { jsPDF } = window.jspdf;

  if (options.customPageSize) {
    // একটা নির্দিষ্ট মাপের (ইঞ্চিতে) একটাই পাতা — যেমন ৩x৩ ইঞ্চি কুরিয়ার স্টিকার — কোনো মার্জিন/কাটাকাটি ছাড়াই
    const [wIn, hIn] = options.customPageSize;
    const wMm = wIn * 25.4;
    const hMm = hIn * 25.4;
    const pdf = new jsPDF({ orientation: wMm >= hMm ? 'l' : 'p', unit: 'mm', format: [wMm, hMm] });
    const imgData = canvas.toDataURL('image/jpeg', 0.97);
    pdf.addImage(imgData, 'JPEG', 0, 0, wMm, hMm);
    await outputAndSharePDF(pdf, filename, title);
    return;
  }

  // পাতার আকার — ডিফল্ট A4, চাইলে A3 (আরও বড়, তাই একই কনটেন্টে কম পাতা লাগবে) ব্যবহার করা যাবে।
  // এটা স্ট্যান্ডার্ড, সব PDF ভিউয়ারে ভালোভাবে সমর্থিত পাতার আকার — কাস্টম বিশাল পাতার চেয়ে নির্ভরযোগ্য
  const marginSideMm = 10; // পাতার ডানে-বামে ফাঁকা জায়গা
  const marginTopBottomMm = 14; // পাতার উপরে-নিচে বাড়তি ফাঁকা জায়গা

  const pdf = new jsPDF('p', 'mm', pageFormat);
  const pdfWidth = pdf.internal.pageSize.getWidth();
  const pdfPageHeight = pdf.internal.pageSize.getHeight();
  const contentWidthMm = pdfWidth - marginSideMm * 2;
  const contentHeightMm = pdfPageHeight - marginTopBottomMm * 2;

  const pxPerMm = canvas.width / contentWidthMm;
  const pageHeightPx = Math.floor(contentHeightMm * pxPerMm);
  const maxSearchUpPx = Math.floor(15 * pxPerMm); // পাতার শেষ প্রান্ত থেকে সর্বোচ্চ ১৫মিমি উপর পর্যন্ত ভালো জায়গা খোঁজা হবে

  let currentY = 0;
  let pageNum = 0;

  while (currentY < canvas.height) {
    const idealEndY = Math.min(currentY + pageHeightPx, canvas.height);
    let cutY = idealEndY;
    if (idealEndY < canvas.height) {
      if (domSafeCutPointsPx.length > 0) {
        // DOM থেকে মাপা এন্ট্রিগুলোর মাঝের সবচেয়ে কাছাকাছি ফাঁকা জায়গা বেছে নেওয়া হচ্ছে (নির্ভরযোগ্য পদ্ধতি)
        const candidates = domSafeCutPointsPx.filter((p) => p > currentY && p <= idealEndY);
        if (candidates.length > 0) {
          cutY = candidates[candidates.length - 1];
        } else {
          // ideal-এর কাছাকাছি কোনো এন্ট্রি-গ্যাপ না থাকলে, পুরনো পিক্সেল-স্ক্যান পদ্ধতি ব্যাকআপ হিসেবে ব্যবহার হবে
          const safeCut = findSafeCutLine(canvas, idealEndY, maxSearchUpPx, { denseCheckLeftPx: denseCheckLeftPx * actualScale });
          if (safeCut > currentY) cutY = safeCut;
        }
      } else {
        // পাতার একদম শেষ অংশ না হলে, সবচেয়ে নিরাপদ জায়গা খুঁজে সেখানে কাটা হচ্ছে
        const safeCut = findSafeCutLine(canvas, idealEndY, maxSearchUpPx, { denseCheckLeftPx: denseCheckLeftPx * actualScale });
        if (safeCut > currentY) cutY = safeCut;
      }
    }

    const sliceHeightPx = cutY - currentY;
    if (sliceHeightPx <= 0) break; // অসীম লুপ এড়ানোর নিরাপত্তা

    const sliceCanvas = document.createElement('canvas');
    sliceCanvas.width = canvas.width;
    sliceCanvas.height = sliceHeightPx;
    const ctx = sliceCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
    ctx.drawImage(canvas, 0, currentY, canvas.width, sliceHeightPx, 0, 0, canvas.width, sliceHeightPx);

    // JPEG (উচ্চ মানের) ব্যবহার করা হচ্ছে — PNG-এর তুলনায় ফাইল সাইজ অনেক ছোট হয়, যাতে অনেক পৃষ্ঠা
    // হয়ে গেলেও PDF ফাইলটা শেয়ার করার মতো যথেষ্ট ছোট থাকে
    const sliceImgData = sliceCanvas.toDataURL('image/jpeg', 0.97);
    const sliceHeightMm = sliceHeightPx / pxPerMm;

    if (pageNum > 0) pdf.addPage();
    pdf.addImage(sliceImgData, 'JPEG', marginSideMm, marginTopBottomMm, contentWidthMm, sliceHeightMm);

    currentY = cutY;
    pageNum++;
  }

  await outputAndSharePDF(pdf, filename, title);
};

// আসল টেক্সট-ভিত্তিক PDF (সার্ভার-সাইড, Puppeteer দিয়ে) — html2canvas+jsPDF-এর "ছবি তোলার" পদ্ধতির
// পরিবর্তে এটা সার্ভারে আসল Chrome ব্যবহার করে HTML থেকে সরাসরি PDF বানায়। বাংলা টেক্সট নিখুঁত থাকে
// (সিলেক্ট/কপি করা যায়, জুম করলে ফাটে না), পাতা-ভাগ Chrome নিজেই সঠিকভাবে করে
const generateServerPDF = async (elementId, filename, title, headers, { format = 'A4' } = {}) => {
  const element = document.getElementById(elementId);
  if (!element) throw new Error('কনটেন্ট পাওয়া যায়নি');

  // প্রিন্টের সময় লুকানো থাকা বাটন/আইকন (print:hidden ক্লাস) বাদ দিয়ে HTML তৈরি করা হচ্ছে
  const clone = element.cloneNode(true);
  clone.querySelectorAll('.print\\:hidden').forEach((el) => el.remove());

  const html = `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8" />
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&family=Noto+Serif+Bengali:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  * { font-family: 'Hind Siliguri', 'Noto Serif Bengali', sans-serif; }
  body { margin: 0; padding: 0; background: #fff; }
</style>
</head>
<body>${clone.outerHTML}</body>
</html>`;

  const res = await fetch(`${API_BASE}/api/generate-pdf`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ html, format, filename })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || 'PDF তৈরি করতে সমস্যা হয়েছে');
  }
  const pdfBlob = await res.blob();
  const file = new File([pdfBlob], `${filename}.pdf`, { type: 'application/pdf' });

  const downloadDirectly = () => {
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: title || filename });
    } catch (shareErr) {
      if (shareErr && shareErr.name === 'AbortError') return; // ইউজার নিজে শেয়ার শিট বন্ধ করলে কিছু করার দরকার নেই
      // নেটওয়ার্ক রিকোয়েস্টে সময় লাগায় ব্রাউজার একে আর "সরাসরি ইউজারের ক্লিক" হিসেবে ধরে না —
      // তখন শেয়ার ব্যর্থ হয়, সেক্ষেত্রে সরাসরি ডাউনলোড করিয়ে দেওয়া হচ্ছে যাতে ফাইলটা অন্তত হাতে পান
      console.error('শেয়ার করতে সমস্যা হয়েছে, সরাসরি ডাউনলোড করা হচ্ছে:', shareErr.message);
      downloadDirectly();
    }
  } else {
    downloadDirectly();
  }
};

const outputAndSharePDF = async (pdf, filename, title) => {
  const pdfBlob = pdf.output('blob');
  const file = new File([pdfBlob], `${filename}.pdf`, { type: 'application/pdf' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: title || filename });
  } else {
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }
};

// আসল টেক্সট-ভিত্তিক PDF (সার্ভার-সাইড Puppeteer) — বাংলা টেক্সট নিখুঁত থাকে, পাতা-ভাগ Chrome নিজেই
// সঠিকভাবে করে, রেজুলেশনের কোনো সমস্যাই নেই — আগের ছবি-ভিত্তিক পদ্ধতির বদলে এখন এটাই ব্যবহার হচ্ছে
const shareStructuredPDF = async (config, filename, title, elementIdFallback, { onStart, onFinish, onError, headers } = {}) => {
  if (onStart) onStart();
  try {
    if (!elementIdFallback) throw new Error('কনটেন্টের আইডি দেওয়া হয়নি');
    await generateServerPDF(elementIdFallback, filename, title, headers);
  } catch (err) {
    if (err && err.name === 'AbortError') return; // ইউজার নিজে শেয়ার শিট বন্ধ করলে এরর দেখানোর দরকার নেই
    console.error('PDF শেয়ার করতে সমস্যা হয়েছে:', err);
    if (onError) onError();
    else alert('শেয়ার করতে সমস্যা হয়েছে, একটু পর আবার চেষ্টা করুন');
  } finally {
    if (onFinish) onFinish();
  }
};

// ক্যাশ মেমোর ডেটাকে PDF কনফিগে রূপান্তর করে (এমপ্লয়ি ভিউ ও ড্যাশবোর্ড দুই জায়গাতেই একই শেপ ব্যবহার হয়)
const buildCashMemoPDFConfig = (staff, memoData) => {
  const sections = [];

  if (staff.rate_type === 'monthly' && memoData.salary) {
    sections.push({
      heading: `দিন-ভিত্তিক হিসাব (দৈনিক রেট ৳${memoData.salary.daily_rate})`,
      columns: ['তারিখ', 'অবস্থা', 'লেট (মিনিট)', 'টাকা'],
      rows: memoData.salary.breakdown.map((d) => [
        d.date,
        d.status === 'present' ? 'উপস্থিত' : d.status === 'absent' ? 'অনুপস্থিত' : 'শুক্রবার (ছুটি)',
        d.late_minutes || '—',
        `৳${d.day_earned}`
      ])
    });
    if (memoData.salary.overtime?.length > 0) {
      sections.push({
        heading: 'ওভারটাইম',
        columns: ['তারিখ', 'ঘণ্টা', 'টাকা'],
        rows: memoData.salary.overtime.map((o) => [o.date, o.hours, `৳${o.amount}`])
      });
    }
  }

  if (staff.rate_type !== 'monthly' && memoData.production.length > 0) {
    sections.push({
      heading: 'প্রোডাকশন এন্ট্রি',
      columns: ['তারিখ', 'প্রোডাক্ট', 'পিস', 'টাকা'],
      rows: memoData.production.map((p) => [p.entry_date?.slice(0, 10), p.product_name, p.quantity, `৳${p.amount}`])
    });
  }

  if (memoData.payments.length > 0) {
    sections.push({
      heading: 'টাকা নেওয়ার হিস্ট্রি',
      columns: ['তারিখ', 'টাকা'],
      rows: memoData.payments.map((pay) => [
        pay.payment_date?.slice(0, 10) + (pay.edited_by_name ? ` (সম্পাদনা: ${pay.edited_by_name})` : ''),
        `৳${pay.amount}`
      ])
    });
  }

  const totalEarned = staff.rate_type === 'monthly'
    ? (memoData.salary ? memoData.salary.total_salary_earned : parseFloat(staff.rate_amount || 0))
    : memoData.production.reduce((s, p) => s + parseFloat(p.amount), 0);
  const totalPaid = memoData.payments.reduce((s, p) => s + parseFloat(p.amount), 0);
  const adjustment = staff.rate_type === 'monthly' && memoData.salary
    ? (memoData.salary.previous_balance_adjustment || 0)
    : (memoData.previousBalanceAdjustment || 0);
  const totalDue = staff.rate_type === 'monthly' && memoData.salary
    ? memoData.salary.total_due
    : (totalEarned - totalPaid + adjustment);

  const totals = [
    ['মোট আয়', `৳ ${totalEarned.toFixed(2)}`],
    ['মোট নিয়েছে', `৳ ${totalPaid.toFixed(2)}`]
  ];
  if (adjustment !== 0) {
    totals.push(['আগের হিসাবের আপডেট', `${adjustment > 0 ? '+' : '−'}৳ ${Math.abs(adjustment).toFixed(2)}`]);
  }
  totals.push(['এখন পাবে', `৳ ${totalDue.toFixed(2)}`, true]);

  return {
    title: 'Maya Garments',
    subtitle: 'কারিগর হিসাব — ক্যাশ মেমো',
    dateLabel: `তারিখ: ${new Date().toLocaleDateString('bn-BD')}`,
    infoLines: [staff.name, `${staff.designation || 'পদবি নেই'}${staff.phone ? ' · ' + staff.phone : ''}`],
    sections,
    totals
  };
};



// বাংলাদেশি নাম্বারকে হোয়াটসঅ্যাপ লিংকের জন্য প্রস্তুত করে (880 কোডসহ)
function toWhatsAppNumber(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('880')) return digits;
  if (digits.startsWith('0')) return '88' + digits;
  return '880' + digits;
}

// বর্তমান সময় HH:MM ফরম্যাটে (time input-এর জন্য)
function nowTimeString() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const STATUS_LABELS = {
  present: { text: 'উপস্থিত', color: 'text-emerald-700', border: 'border-emerald-500', bg: 'bg-emerald-50' },
  on_break: { text: 'বিরতিতে', color: 'text-amber-700', border: 'border-amber-500', bg: 'bg-amber-50' },
  checked_out: { text: 'কাজ শেষ', color: 'text-gray-500', border: 'border-gray-300', bg: 'bg-gray-50' },
  not_marked: { text: 'মার্ক করা হয়নি', color: 'text-red-700', border: 'border-red-300', bg: 'bg-red-50' }
};

function LoginScreen({ onLoggedIn }) {
  const [loginMode, setLoginMode] = useState('admin'); // 'admin' | 'employee'
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showModeratorNote, setShowModeratorNote] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    if (!phone.trim() || !password.trim()) {
      setError('ফোন নাম্বার এবং পাসওয়ার্ড দিতে হবে');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        localStorage.setItem('maya_token', data.token);
        localStorage.setItem('maya_user', JSON.stringify(data.user));
        onLoggedIn(data.user, data.token);
      } else {
        setError(data.message || 'লগইন করা যায়নি');
      }
    } catch (err) {
      setError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEmployeeLogin = async (e) => {
    e.preventDefault();
    setError('');
    if (!phone.trim()) {
      setError('ফোন নাম্বার দিতে হবে');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/staff-auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        const employeeUser = { role: 'employee', staff_id: data.staff.id, name: data.staff.name, phone: data.staff.phone };
        localStorage.setItem('maya_token', data.token);
        localStorage.setItem('maya_user', JSON.stringify(employeeUser));
        onLoggedIn(employeeUser, data.token);
      } else {
        setError(data.message || 'লগইন করা যায়নি');
      }
    } catch (err) {
      setError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
      <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen flex flex-col items-center px-6 pt-16">
        <div className="w-20 h-20 rounded-full bg-[#075B68] flex items-center justify-center mb-6">
          <ShieldCheck size={34} className="text-amber-400" />
        </div>
        <h1 className="text-xl font-extrabold text-gray-900 mb-1">Maya Garments</h1>
        <p className="text-sm text-gray-500 mb-6">{loginMode === 'admin' ? 'Admin Login' : 'স্টাফ/কারিগর লগইন'}</p>

        <div className="flex w-full mb-6 bg-white rounded-xl p-1 border border-gray-200">
          <button
            onClick={() => { setLoginMode('admin'); setError(''); }}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold ${loginMode === 'admin' ? 'bg-[#075B68] text-white' : 'text-gray-500'}`}
          >
            এডমিন/মডারেটর
          </button>
          <button
            onClick={() => { setLoginMode('employee'); setError(''); }}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold ${loginMode === 'employee' ? 'bg-[#075B68] text-white' : 'text-gray-500'}`}
          >
            স্টাফ/কারিগর
          </button>
        </div>

        {loginMode === 'admin' ? (
          <form onSubmit={handleLogin} className="w-full space-y-4">
            <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3">
              <Phone size={18} className="text-gray-400" />
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="ফোন নাম্বার"
                className="flex-1 text-sm focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3">
              <Lock size={18} className="text-gray-400" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="পাসওয়ার্ড"
                className="flex-1 text-sm focus:outline-none"
              />
            </div>

            {error && <p className="text-sm text-red-600 text-center">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-[#075B68] text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2 active:bg-[#034B58] disabled:opacity-60"
            >
              {submitting ? <Loader2 size={18} className="animate-spin" /> : <LogIn size={18} />}
              {submitting ? 'লগইন হচ্ছে...' : 'Login'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleEmployeeLogin} className="w-full space-y-4">
            <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-4 py-3">
              <Phone size={18} className="text-gray-400" />
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="আপনার ফোন নাম্বার"
                className="flex-1 text-sm focus:outline-none"
              />
            </div>
            <p className="text-xs text-gray-400 text-center">
              যে ফোন নাম্বার দিয়ে আপনাকে স্টাফ হিসেবে যোগ করা হয়েছে, সেটা লিখুন — পাসওয়ার্ড লাগবে না
            </p>

            {error && <p className="text-sm text-red-600 text-center">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-[#075B68] text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2 active:bg-[#034B58] disabled:opacity-60"
            >
              {submitting ? <Loader2 size={18} className="animate-spin" /> : <LogIn size={18} />}
              {submitting ? 'লগইন হচ্ছে...' : 'লগইন করুন'}
            </button>
          </form>
        )}

        {loginMode === 'admin' && (
          <div className="w-full mt-8 text-center">
            <p className="text-xs text-gray-400 mb-2">Don't have moderator access yet?</p>
            <button
              onClick={() => setShowModeratorNote(true)}
              className="text-sm font-semibold text-gray-400 underline decoration-dotted cursor-not-allowed"
            >
              Moderator Login
            </button>
            {showModeratorNote && (
              <p className="text-xs text-amber-600 mt-2">শীঘ্রই চালু হবে — আপাতত শুধু এডমিন লগইন করা যাবে</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// এমপ্লয়ি/কারিগর লগইন করলে এই সীমিত ভিউ দেখবে — শুধু নিজের তথ্য
function EmployeeView({ currentUser, onLogout }) {
  const [staffDetail, setStaffDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [salaryVisible, setSalaryVisible] = useState(false);
  const hideTimerRef = useRef(null);

  // বিস্তারিত ড্রিল-ডাউন
  const [detailView, setDetailView] = useState(null); // null | 'attendance' | 'production' | 'payments'
  const [detailList, setDetailList] = useState([]);
  const [detailListLoading, setDetailListLoading] = useState(false);

  // ক্যাশ মেমো
  const [showCashMemo, setShowCashMemo] = useState(false);
  const [sharingPDF, setSharingPDF] = useState(false);
  const [cashMemoData, setCashMemoData] = useState(null);
  const [cashMemoLoading, setCashMemoLoading] = useState(false);

  const revealSalary = () => {
    setSalaryVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setSalaryVisible(false), 10000);
  };

  const openDetailView = async (view) => {
    setDetailView(view);
    setDetailListLoading(true);
    setDetailList([]);
    try {
      let url = '';
      if (view === 'attendance') url = `${API_BASE}/api/attendance/daily/${staffDetail.id}?days=30`;
      if (view === 'production') url = `${API_BASE}/api/production/staff/${staffDetail.id}`;
      if (view === 'payments') url = `${API_BASE}/api/staff-payments/staff/${staffDetail.id}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'ok') {
        setDetailList(data.days || data.entries || data.payments || []);
      }
    } catch (err) {
      console.error('বিস্তারিত লিস্ট আনতে সমস্যা হয়েছে:', err);
    } finally {
      setDetailListLoading(false);
    }
  };

  const openCashMemo = async () => {
    setShowCashMemo(true);
    setCashMemoLoading(true);
    setCashMemoData(null);
    try {
      const isMonthly = staffDetail.rate_type === 'monthly';
      const [prodRes, payRes, salRes, adjRes] = await Promise.all([
        fetch(`${API_BASE}/api/production/staff/${staffDetail.id}`, { cache: 'no-store' }),
        fetch(`${API_BASE}/api/staff-payments/staff/${staffDetail.id}`, { cache: 'no-store' }),
        isMonthly ? fetch(`${API_BASE}/api/salary/staff/${staffDetail.id}/summary?days=30`, { cache: 'no-store' }) : Promise.resolve(null),
        fetch(`${API_BASE}/api/staff/${staffDetail.id}/balance-adjustments`, { cache: 'no-store' })
      ]);
      const prodData = await prodRes.json();
      const payData = await payRes.json();
      const salData = salRes ? await salRes.json() : null;
      const adjData = await adjRes.json();
      const adjustmentTotal = adjData.status === 'ok'
        ? adjData.adjustments.reduce((sum, a) => sum + parseFloat(a.amount), 0)
        : 0;
      setCashMemoData({
        production: prodData.status === 'ok' ? prodData.entries : [],
        payments: payData.status === 'ok' ? payData.payments : [],
        salary: salData && salData.status === 'ok' ? salData.salary : null,
        previousBalanceAdjustment: adjustmentTotal
      });
    } catch (err) {
      console.error('ক্যাশ মেমো আনতে সমস্যা হয়েছে:', err);
    } finally {
      setCashMemoLoading(false);
    }
  };

  useEffect(() => {
    const fetchMyDetail = async () => {
      setLoading(true);
      try {
        const staffId = currentUser.staff_id;
        const staffListRes = await fetch(`${API_BASE}/api/staff`, { cache: 'no-store' });
        const staffListData = await staffListRes.json();
        const staffRecord = (staffListData.staff || []).find((s) => s.id === staffId) || { name: currentUser.name };
        const isMonthly = staffRecord.rate_type === 'monthly';

        const [attRes, prodRes, payRes, salRes] = await Promise.all([
          fetch(`${API_BASE}/api/attendance/summary/${staffId}?days=30`, { cache: 'no-store' }),
          fetch(`${API_BASE}/api/production/staff/${staffId}/summary`, { cache: 'no-store' }),
          fetch(`${API_BASE}/api/staff-payments/staff/${staffId}/summary`, { cache: 'no-store' }),
          isMonthly ? fetch(`${API_BASE}/api/salary/staff/${staffId}/summary?days=30`, { cache: 'no-store' }) : Promise.resolve(null)
        ]);
        const attData = await attRes.json();
        const prodData = await prodRes.json();
        const payData = await payRes.json();
        const salData = salRes ? await salRes.json() : null;

        setStaffDetail({
          ...staffRecord,
          id: staffId,
          attendance: attData.status === 'ok' ? attData.summary : null,
          production: prodData.status === 'ok' ? prodData.summary : null,
          payments: payData.status === 'ok' ? payData.summary : null,
          salary: salData && salData.status === 'ok' ? salData.salary : null
        });
      } catch (err) {
        console.error('নিজের বিস্তারিত আনতে সমস্যা হয়েছে:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchMyDetail();
  }, [currentUser.staff_id]);

  // ক্যাশ মেমো — ফুল পেজ (প্রিন্টযোগ্য)
  if (showCashMemo) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center print:bg-white">
        <div id="employee-cash-memo" className="w-full sm:max-w-sm bg-white min-h-screen p-6">
          <div className="flex items-center justify-between mb-4 print:hidden">
            <button onClick={() => setShowCashMemo(false)} className="text-gray-400">
              <ChevronRight size={22} className="rotate-180" />
            </button>
            <h2 className="text-lg font-bold text-gray-900">ক্যাশ মেমো</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  shareStructuredPDF(
                    buildCashMemoPDFConfig(staffDetail, cashMemoData),
                    `cash-memo-${staffDetail?.name || 'staff'}`,
                    'ক্যাশ মেমো',
                    'employee-cash-memo',
                    {
                      onStart: () => setSharingPDF(true),
                      onFinish: () => setSharingPDF(false),
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('maya_token') || ''}` }
                    }
                  )
                }
                disabled={sharingPDF}
                className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center active:scale-90 active:bg-emerald-200 transition-transform disabled:opacity-60"
              >
                {sharingPDF ? <Loader2 size={16} className="text-emerald-700 animate-spin" /> : <Share2 size={16} className="text-emerald-700" />}
              </button>
              <button
                onClick={() => window.print()}
                className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center active:scale-90 active:bg-red-200 transition-transform"
              >
                <Printer size={16} className="text-red-800" />
              </button>
            </div>
          </div>

          <div className="text-center border-b-2 border-dashed border-gray-300 pb-4 mb-4">
            <h1 className="text-xl font-extrabold text-[#075B68] tracking-wide">Maya Garments</h1>
            <p className="text-xs text-gray-500 mt-1">চেয়ারম্যান বাড়ির মোড়, কামরাঙ্গীরচর, ঢাকা-১২১১</p>
            <p className="text-xs text-gray-500">যোগাযোগঃ 01783203215, 01762037641</p>
            <p className="text-xs text-gray-500 mt-2">কারিগর হিসাব — ক্যাশ মেমো</p>
            <p className="text-xs text-gray-400 mt-1">তারিখ: {new Date().toLocaleDateString('bn-BD')}</p>
          </div>

          <div className="mb-4">
            <p className="font-semibold text-gray-900">{staffDetail.name}</p>
            <p className="text-xs text-gray-500">{staffDetail.designation || 'পদবি নেই'} {staffDetail.phone ? `· ${staffDetail.phone}` : ''}</p>
          </div>

          {cashMemoLoading ? (
            <div className="flex justify-center py-10 print:hidden">
              <Loader2 size={28} className="animate-spin text-[#034B58]" />
            </div>
          ) : cashMemoData ? (
            <>
              {staffDetail.rate_type === 'monthly' && cashMemoData.salary && (
                <div className="mb-4">
                  <div className="bg-amber-50 rounded-2xl p-4 flex items-center justify-between mb-3">
                    <span className="text-sm text-gray-600">মাসিক বেতন</span>
                    <span className="text-lg font-bold text-[#075B68]">৳ {staffDetail.rate_amount}</span>
                  </div>
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">দিন-ভিত্তিক হিসাব (দৈনিক রেট ৳{cashMemoData.salary.daily_rate})</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5">অবস্থা</td>
                        <td className="py-1.5 text-right">লেট (মিনিট)</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {cashMemoData.salary.breakdown.map((d, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="py-1.5">{d.date}</td>
                          <td className="py-1.5">
                            {d.status === 'present' && 'উপস্থিত'}
                            {d.status === 'absent' && 'অনুপস্থিত'}
                            {d.status === 'holiday' && 'শুক্রবার (ছুটি)'}
                          </td>
                          <td className="py-1.5 text-right">{d.late_minutes || '—'}</td>
                          <td className="py-1.5 text-right">৳{d.day_earned}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {staffDetail.rate_type === 'monthly' && cashMemoData.salary?.overtime?.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">ওভারটাইম</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5 text-right">ঘণ্টা</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {cashMemoData.salary.overtime.map((o, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="py-1.5">{o.date}</td>
                          <td className="py-1.5 text-right">{o.hours}</td>
                          <td className="py-1.5 text-right">৳{o.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex justify-between text-sm mt-2 pt-2 border-t border-gray-200">
                    <span className="text-gray-600">মোট ওভারটাইম</span>
                    <span className="font-semibold text-gray-900">৳ {cashMemoData.salary.total_overtime_amount}</span>
                  </div>
                </div>
              )}

              {staffDetail.rate_type !== 'monthly' && cashMemoData.production.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">প্রোডাকশন এন্ট্রি</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5">প্রোডাক্ট</td>
                        <td className="py-1.5 text-right">পিস</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {cashMemoData.production.map((p) => (
                        <tr key={p.id} className="border-b border-gray-100">
                          <td className="py-1.5">{p.entry_date?.slice(0, 10)}</td>
                          <td className="py-1.5">{p.product_name}</td>
                          <td className="py-1.5 text-right">{p.quantity}</td>
                          <td className="py-1.5 text-right">৳{p.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {cashMemoData.payments.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">টাকা নেওয়ার হিস্ট্রি</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {cashMemoData.payments.map((pay) => (
                        <tr key={pay.id} className="border-b border-gray-100">
                          <td className="py-1.5">
                            {pay.payment_date?.slice(0, 10)}
                            {pay.edited_by_name && <span className="block text-[10px] text-amber-600">সম্পাদনা: {pay.edited_by_name}</span>}
                          </td>
                          <td className="py-1.5 text-right">৳{pay.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="border-t-2 border-dashed border-gray-300 pt-4 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">মোট আয়</span>
                  <span className="font-semibold text-gray-900">
                    ৳ {(staffDetail.rate_type === 'monthly'
                      ? (cashMemoData.salary ? cashMemoData.salary.total_salary_earned : parseFloat(staffDetail.rate_amount || 0))
                      : cashMemoData.production.reduce((s, p) => s + parseFloat(p.amount), 0)
                    ).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">মোট নিয়েছে</span>
                  <span className="font-semibold text-gray-900">
                    ৳ {cashMemoData.payments.reduce((s, p) => s + parseFloat(p.amount), 0).toFixed(2)}
                  </span>
                </div>
                {(() => {
                  const adj = staffDetail.rate_type === 'monthly' && cashMemoData.salary
                    ? (cashMemoData.salary.previous_balance_adjustment || 0)
                    : (cashMemoData.previousBalanceAdjustment || 0);
                  return adj !== 0 ? (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">আগের হিসাবের আপডেট</span>
                      <span className={`font-semibold ${adj > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                        {adj > 0 ? '+' : '−'}৳ {Math.abs(adj).toFixed(2)}
                      </span>
                    </div>
                  ) : null;
                })()}
                <div className="flex justify-between text-base pt-2 border-t border-gray-200 mt-2">
                  <span className="font-bold text-gray-900">এখন পাবে</span>
                  <span className="font-extrabold text-[#075B68]">
                    ৳ {(staffDetail.rate_type === 'monthly' && cashMemoData.salary
                      ? cashMemoData.salary.total_due
                      : (cashMemoData.production.reduce((s, p) => s + parseFloat(p.amount), 0) - cashMemoData.payments.reduce((s, p) => s + parseFloat(p.amount), 0) + (cashMemoData.previousBalanceAdjustment || 0))
                    ).toFixed(2)}
                  </span>
                </div>
              </div>

              <p className="text-center text-xs text-gray-400 mt-6 print:mt-10">— ধন্যবাদ —</p>
            </>
          ) : (
            <p className="text-sm text-gray-500 text-center py-8">ডেটা পাওয়া যায়নি</p>
          )}
        </div>

        {/* PDF তৈরি হওয়ার সময় লোডিং ওভারলে — ক্যাপচার হওয়া কনটেন্টের বাইরে, যাতে PDF-এ না আসে */}
        {sharingPDF && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 print:hidden">
            <div className="bg-white rounded-2xl px-6 py-5 flex flex-col items-center gap-3">
              <Loader2 size={28} className="animate-spin text-[#034B58]" />
              <p className="text-sm font-semibold text-gray-700">একটু অপেক্ষা করুন, তৈরি হচ্ছে...</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // বিস্তারিত ড্রিল-ডাউন — ফুল পেজ
  if (detailView) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => setDetailView(null)} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">
              {detailView === 'attendance' && 'উপস্থিতির বিস্তারিত'}
              {detailView === 'production' && 'প্রোডাকশনের বিস্তারিত'}
              {detailView === 'payments' && 'পেমেন্টের বিস্তারিত'}
            </h1>
          </div>
          <div className="p-4">
            {detailListLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 size={28} className="animate-spin text-[#034B58]" />
              </div>
            ) : detailList.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">কোনো তথ্য পাওয়া যায়নি</p>
            ) : (
              <div className="flex flex-col gap-3">
                {detailView === 'attendance' && detailList.map((d, i) => (
                  <div key={i} className={`bg-white rounded-2xl shadow-md p-4 border-l-4 ${d.status === 'present' ? 'border-emerald-500' : 'border-red-500'}`}>
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-gray-900 text-sm">{d.date}</p>
                      {d.status === 'absent' ? (
                        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-red-50 text-red-700">অনুপস্থিত</span>
                      ) : (
                        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">উপস্থিত</span>
                      )}
                    </div>
                    {d.status === 'present' && (
                      <div className="mt-2 space-y-2">
                        {d.shift1?.attended ? (
                          <div className="bg-sky-50 rounded-lg p-2.5 text-xs text-gray-600">
                            <p className="font-semibold text-sky-800 mb-1">শিফট ১</p>
                            <p>ঢুকেছে: {d.shift1.check_in ? new Date(d.shift1.check_in).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' }) : '—'}</p>
                            <p>
                              বের হয়েছে: {d.shift1.check_out
                                ? new Date(d.shift1.check_out).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })
                                : (d.shift1.shift_end ? `${new Date(d.shift1.shift_end).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })} (ডিউটি টাইম)` : '—')}
                            </p>
                            {d.shift1.late_minutes > 0 && <p className="text-orange-600 font-medium">লেট: {d.shift1.late_minutes} মিনিট</p>}
                            {d.shift1.is_partial && <p className="text-red-600 font-medium">মাঝপথে চলে গেছে</p>}
                          </div>
                        ) : d.shift1?.shift_end ? (
                          <div className="bg-red-50 rounded-lg p-2.5 text-xs">
                            <p className="font-semibold text-red-700">শিফট ১ অনুপস্থিত</p>
                          </div>
                        ) : null}
                        {d.shift2?.attended ? (
                          <div className="bg-indigo-50 rounded-lg p-2.5 text-xs text-gray-600">
                            <p className="font-semibold text-indigo-800 mb-1">শিফট ২</p>
                            <p>ঢুকেছে: {d.shift2.check_in ? new Date(d.shift2.check_in).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' }) : '—'}</p>
                            <p>
                              বের হয়েছে: {d.shift2.check_out
                                ? new Date(d.shift2.check_out).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })
                                : (d.shift2.shift_end ? `${new Date(d.shift2.shift_end).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })} (ডিউটি টাইম)` : '—')}
                            </p>
                            {d.shift2.late_minutes > 0 && <p className="text-orange-600 font-medium">লেট: {d.shift2.late_minutes} মিনিট</p>}
                            {d.shift2.is_partial && <p className="text-red-600 font-medium">মাঝপথে চলে গেছে</p>}
                          </div>
                        ) : d.shift2?.shift_end ? (
                          <div className="bg-red-50 rounded-lg p-2.5 text-xs">
                            <p className="font-semibold text-red-700">শিফট ২ অনুপস্থিত</p>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}

                {detailView === 'production' && detailList.map((p) => (
                  <div key={p.id} className="bg-white rounded-2xl shadow-md p-4 flex items-center justify-between border-l-4 border-amber-500">
                    <div>
                      <p className="font-semibold text-gray-900 text-sm">{p.product_name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{p.entry_date?.slice(0, 10)} · {p.quantity} পিস</p>
                    </div>
                    <p className="text-sm font-semibold text-[#034B58]">৳ {p.amount}</p>
                  </div>
                ))}

                {detailView === 'payments' && detailList.map((pay) => (
                  <div key={pay.id} className="bg-white rounded-2xl shadow-md p-4 flex items-center justify-between border-l-4 border-emerald-500">
                    <p className="text-xs text-gray-500">{pay.payment_date?.slice(0, 10)}</p>
                    <p className="text-sm font-semibold text-[#034B58]">৳ {pay.amount}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
      <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
        <div className="bg-[#075B68] text-white px-4 py-4 flex items-center justify-between gap-3 sticky top-0 z-10">
          <div>
            <h1 className="text-base font-bold">{currentUser.name}</h1>
            <p className="text-xs text-white/70">{staffDetail?.designation || ''}</p>
          </div>
          <button onClick={onLogout} className="text-white/80 text-sm font-semibold bg-white/10 rounded-full px-3 py-1.5">
            লগআউট
          </button>
        </div>

        <div className="p-4">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 size={28} className="animate-spin text-[#034B58]" />
            </div>
          ) : !staffDetail ? (
            <p className="text-sm text-gray-500 text-center py-8">তথ্য পাওয়া যায়নি</p>
          ) : (
            <div className="space-y-6">
              {/* উপস্থিতি */}
              <div>
                <h3 className="text-sm font-bold text-gray-700 mb-3">গত ৩০ দিনের উপস্থিতি</h3>
                {staffDetail.attendance ? (
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-emerald-500 active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.present_days}</p>
                      <p className="text-xs text-gray-500 mt-0.5">উপস্থিত দিন</p>
                    </button>
                    <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-red-500 active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.absent_days}</p>
                      <p className="text-xs text-gray-500 mt-0.5">অনুপস্থিত দিন</p>
                    </button>
                    <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-sky-500 active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.shift1_present_days || 0}</p>
                      <p className="text-xs text-gray-500 mt-0.5">শিফট ১ উপস্থিত</p>
                    </button>
                    <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-indigo-500 active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.shift2_present_days || 0}</p>
                      <p className="text-xs text-gray-500 mt-0.5">শিফট ২ উপস্থিত</p>
                    </button>
                    <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-[#034B58] active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.present_hours}</p>
                      <p className="text-xs text-gray-500 mt-0.5">উপস্থিত ঘণ্টা</p>
                    </button>
                    <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-amber-500 active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.break_hours}</p>
                      <p className="text-xs text-gray-500 mt-0.5">ব্রেক ঘণ্টা</p>
                    </button>
                    <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-orange-500 active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.late_hours}</p>
                      <p className="text-xs text-gray-500 mt-0.5">মোট লেট (ঘণ্টা)</p>
                    </button>
                    <div className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-cyan-500">
                      <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.overtime_hours || 0}</p>
                      <p className="text-xs text-gray-500 mt-0.5">মোট ওভারটাইম (ঘণ্টা)</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">ডেটা পাওয়া যায়নি</p>
                )}
              </div>

              {/* বেতন / প্রোডাকশন */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-gray-700">
                    {staffDetail.rate_type === 'monthly' ? 'বেতন হিসাব' : 'প্রোডাকশন হিসাব'}
                  </h3>
                  <button
                    onClick={revealSalary}
                    className="text-xs font-semibold text-[#034B58] bg-red-50 rounded-full px-3 py-1.5 flex items-center gap-1"
                  >
                    <Eye size={13} /> {salaryVisible ? 'দেখা যাচ্ছে' : 'বেতন দেখুন'}
                  </button>
                </div>
                {staffDetail.rate_type === 'monthly' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-white rounded-2xl shadow-md p-4 border-l-4 border-amber-500">
                      <p className="text-2xl font-bold text-gray-900">{salaryVisible ? `৳ ${staffDetail.rate_amount || 0}` : '৳ ****'}</p>
                      <p className="text-xs text-gray-500 mt-0.5">আপনার বেতন</p>
                    </div>
                    <button onClick={openCashMemo} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-[#034B58] active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{salaryVisible ? `৳ ${staffDetail.salary?.total_salary_earned ?? 0}` : '৳ ****'}</p>
                      <p className="text-xs text-gray-500 mt-0.5">আজকে পর্যন্ত মোট বেতন</p>
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => openDetailView('production')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-amber-500 active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{staffDetail.production?.total_quantity || 0}</p>
                      <p className="text-xs text-gray-500 mt-0.5">মোট পিস</p>
                    </button>
                    <button onClick={() => openDetailView('production')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-[#034B58] active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{salaryVisible ? `৳ ${staffDetail.production?.total_amount || 0}` : '৳ ****'}</p>
                      <p className="text-xs text-gray-500 mt-0.5">মোট আয়</p>
                    </button>
                  </div>
                )}
              </div>

              {/* পেমেন্ট */}
              <div>
                <h3 className="text-sm font-bold text-gray-700 mb-3">সাপ্তাহিক পেমেন্ট হিসাব</h3>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => openDetailView('payments')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-emerald-500 active:opacity-80">
                    <p className="text-2xl font-bold text-gray-900">{salaryVisible ? `৳ ${staffDetail.payments?.total_paid || 0}` : '৳ ****'}</p>
                    <p className="text-xs text-gray-500 mt-0.5">মোট দেওয়া হয়েছে</p>
                  </button>
                  <button onClick={() => openDetailView('payments')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-gray-300 active:opacity-80">
                    <p className="text-2xl font-bold text-gray-900">{staffDetail.payments?.payment_count || 0}</p>
                    <p className="text-xs text-gray-500 mt-0.5">মোট বার</p>
                  </button>
                  <button onClick={openCashMemo} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-[#075B68] col-span-2 active:opacity-80">
                    <p className="text-2xl font-bold text-gray-900">
                      {salaryVisible ? `৳ ${(
                        staffDetail.rate_type === 'monthly'
                          ? parseFloat(staffDetail.salary?.total_due ?? (parseFloat(staffDetail.rate_amount || 0) - parseFloat(staffDetail.payments?.total_paid || 0)))
                          : (parseFloat(staffDetail.production?.total_amount || 0) - parseFloat(staffDetail.payments?.total_paid || 0))
                      ).toFixed(2)}` : '৳ ****'}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">মোট পাওনা — ক্যাশ মেমো দেখতে ক্লিক করুন</p>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Dashboard({ currentUser, onLogout, onUpdateUser }) {
  const [balanceHidden, setBalanceHidden] = useState(true);
  const [staffList, setStaffList] = useState([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showEmployeeModal, setShowEmployeeModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [form, setForm] = useState({
    name: '',
    phone: '',
    designation: '',
    joining_date: '',
    rate_type: 'piece',
    rate_amount: '',
    machine_user_id: ''
  });
  const [editingStaffId, setEditingStaffId] = useState(null);

  // উপস্থিতি সংক্রান্ত state
  const [attendanceToday, setAttendanceToday] = useState([]);
  const [showAttendanceModal, setShowAttendanceModal] = useState(false);
  const [showAbsentModal, setShowAbsentModal] = useState(false);

  // ডিউটি টাইম state
  const [showDutyForm, setShowDutyForm] = useState(false);
  const [dutyForm, setDutyForm] = useState({ shift1_start: '09:00', shift1_end: '14:00', shift2_start: '15:00', shift2_end: '22:00' });
  const [dutySubmitting, setDutySubmitting] = useState(false);

  // মেশিন state
  const [showMachineForm, setShowMachineForm] = useState(false);
  const [machines, setMachines] = useState([]);
  const [machineForm, setMachineForm] = useState({ name: '', ip_address: '', port: '4370' });
  const [machineSubmitting, setMachineSubmitting] = useState(false);
  const [machineError, setMachineError] = useState('');
  const [syncInterval, setSyncInterval] = useState('30');
  const [balanceTrend, setBalanceTrend] = useState(null); // { percent_change, direction }
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [syncIntervalSaving, setSyncIntervalSaving] = useState(false);
  const [syncIntervalSaved, setSyncIntervalSaved] = useState(false);
  const [showLateGraceForm, setShowLateGraceForm] = useState(false);
  const [lateGraceMinutes, setLateGraceMinutes] = useState('20');
  const [lateGraceSaving, setLateGraceSaving] = useState(false);
  const [lateGraceSaved, setLateGraceSaved] = useState(false);
  const [editingMachineId, setEditingMachineId] = useState(null);

  // প্রোফাইল/লগআউট এবং ইউজার ম্যানেজমেন্ট state
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: '', photo_url: '', current_password: '', new_password: '' });
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [users, setUsers] = useState([]);
  const [userForm, setUserForm] = useState({ name: '', phone: '', password: '', role: 'moderator', is_partner: false });
  const [editingUserId, setEditingUserId] = useState(null);
  const [userSubmitting, setUserSubmitting] = useState(false);
  const [userError, setUserError] = useState('');

  // আজকের উপস্থিতি রিসেট (পাসওয়ার্ড কনফার্মেশন সহ) state
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetPasswordInput, setResetPasswordInput] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetSubmitting, setResetSubmitting] = useState(false);

  // সব স্টাফ পেমেন্ট রিসেট (টেস্ট ডেটা মুছার জন্য, পাসওয়ার্ড কনফার্মেশন সহ) state
  const [showPaymentResetConfirm, setShowPaymentResetConfirm] = useState(false);
  const [paymentResetPasswordInput, setPaymentResetPasswordInput] = useState('');
  const [paymentResetError, setPaymentResetError] = useState('');
  const [paymentResetSubmitting, setPaymentResetSubmitting] = useState(false);

  // সব পার্টনার হিসাব রিসেট (টেস্ট ডেটা মুছার জন্য, পাসওয়ার্ড কনফার্মেশন সহ) state
  const [showPartnerResetConfirm, setShowPartnerResetConfirm] = useState(false);
  const [partnerResetPasswordInput, setPartnerResetPasswordInput] = useState('');
  const [partnerResetError, setPartnerResetError] = useState('');
  const [partnerResetSubmitting, setPartnerResetSubmitting] = useState(false);

  // পার্টনার হিসাব state
  const [showPartnerList, setShowPartnerList] = useState(false);
  const [showPartnerLogPage, setShowPartnerLogPage] = useState(false);

  // ওভারটাইম state
  const [showOvertimePage, setShowOvertimePage] = useState(false);
  const [overtimeView, setOvertimeView] = useState('choose'); // choose | start-select
  const [overtimeActiveSessions, setOvertimeActiveSessions] = useState([]);
  const [overtimeSelectedStaff, setOvertimeSelectedStaff] = useState([]);
  const [overtimeStarting, setOvertimeStarting] = useState(false);
  const [overtimeEnding, setOvertimeEnding] = useState(false);
  const [overtimeEndResult, setOvertimeEndResult] = useState(null);
  const [overtimeLog, setOvertimeLog] = useState([]);

  // পাইকার (Wholesaler) state
  const [showWholesalerLockPrompt, setShowWholesalerLockPrompt] = useState(false);
  const [wholesalerLockTarget, setWholesalerLockTarget] = useState('add'); // 'add' | 'account'
  const [wholesalerPasswordInput, setWholesalerPasswordInput] = useState('');
  const [wholesalerPasswordError, setWholesalerPasswordError] = useState('');
  const [showWholesalerPage, setShowWholesalerPage] = useState(false);
  const [wholesalers, setWholesalers] = useState([]);
  const [showAddWholesalerForm, setShowAddWholesalerForm] = useState(false);
  const [wholesalerForm, setWholesalerForm] = useState({ name: '', address: '', phone: '' });
  const [wholesalerSubmitting, setWholesalerSubmitting] = useState(false);
  const [wholesalerError, setWholesalerError] = useState('');
  const [editingWholesalerId, setEditingWholesalerId] = useState(null);
  const [deletingWholesalerId, setDeletingWholesalerId] = useState(null);
  const [showWholesalerRatePage, setShowWholesalerRatePage] = useState(false);
  const [selectedWholesalerForRate, setSelectedWholesalerForRate] = useState(null);
  const [wholesalerRates, setWholesalerRates] = useState([]);
  const [wholesalerRateForm, setWholesalerRateForm] = useState({ product_name: '', price: '' });
  const [editingRateId, setEditingRateId] = useState(null);

  // পাইকারি হিসাব state
  const [showWholesalerAccountSelectPage, setShowWholesalerAccountSelectPage] = useState(false);
  const [selectedWholesalerForAccount, setSelectedWholesalerForAccount] = useState(null);
  const [wholesalerAccountSummary, setWholesalerAccountSummary] = useState(null);

  // ম্যানুয়ালি উপস্থিতি যুক্ত করুন state
  const [showManualAttendancePage, setShowManualAttendancePage] = useState(false);
  const [manualAttendanceStaff, setManualAttendanceStaff] = useState(null);
  const [manualSelectedDates, setManualSelectedDates] = useState([]);
  const [manualSelectedShifts, setManualSelectedShifts] = useState([1]);
  const [manualAddSubmitting, setManualAddSubmitting] = useState(false);
  const [recentManualAdds, setRecentManualAdds] = useState([]);
  const [wholesalerLedger, setWholesalerLedger] = useState([]);
  const [wholesalerAccountProducts, setWholesalerAccountProducts] = useState([]);
  const [ledgerForm, setLedgerForm] = useState(null); // { type: 'add'|'return', product_name, quantity, editingId }
  const [ledgerFormError, setLedgerFormError] = useState('');
  const [ledgerSubmitting, setLedgerSubmitting] = useState(false);
  const [paymentForm, setPaymentForm] = useState(null); // { description, amount, editingId }
  const [paymentFormError, setPaymentFormError] = useState('');
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [showProductRefList, setShowProductRefList] = useState(false);
  const [wholesalerRateSubmitting, setWholesalerRateSubmitting] = useState(false);

  // স্টাফ/কারিগর লিস্টে সার্চ করার জন্য — নাম বা ফোন নাম্বার দিয়ে
  const [staffSearchQuery, setStaffSearchQuery] = useState('');
  const matchesStaffSearch = (s) => {
    if (!staffSearchQuery.trim()) return true;
    const q = staffSearchQuery.trim().toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.phone && s.phone.includes(q));
  };
  const [showOvertimeEndConfirm, setShowOvertimeEndConfirm] = useState(false);
  const [allPartnerTransactions, setAllPartnerTransactions] = useState([]);
  const [partnerLogLoading, setPartnerLogLoading] = useState(false);
  const [partners, setPartners] = useState([]);
  const [selectedPartner, setSelectedPartner] = useState(null);
  const [partnerTransactions, setPartnerTransactions] = useState([]);
  const [partnerSummary, setPartnerSummary] = useState(null);
  const [partnerDetailLoading, setPartnerDetailLoading] = useState(false);
  const [partnerTxnForm, setPartnerTxnForm] = useState(null); // { type: 'expense'|'cash_in', editingId: null|id, description, amount, image_url }
  const [reactingTxnId, setReactingTxnId] = useState(null); // কোন পোস্টের রিয়েক্ট পিকার খোলা আছে
  const [viewingReactorsTxn, setViewingReactorsTxn] = useState(null); // কোন পোস্টে কে রিয়েক্ট দিয়েছে দেখানো হচ্ছে
  const [viewingFullImage, setViewingFullImage] = useState(null); // পোস্টের ছবি বড় করে দেখানো হচ্ছে

  // বেতন হাইড/শো — ডিফল্টভাবে লুকানো, ক্লিক করলে ১০ সেকেন্ডের জন্য দেখাবে
  const [salaryVisible, setSalaryVisible] = useState(false);
  const salaryHideTimerRef = useRef(null);
  const revealSalary = () => {
    setSalaryVisible(true);
    if (salaryHideTimerRef.current) clearTimeout(salaryHideTimerRef.current);
    salaryHideTimerRef.current = setTimeout(() => setSalaryVisible(false), 10000);
  };
  // এমপ্লয়ি লিস্টের জন্য — প্রতিটা স্টাফের বেতন আলাদাভাবে হাইড/শো (একজনেরটা দেখালে অন্যদেরটা বদলাবে না)
  const [visibleSalaryIds, setVisibleSalaryIds] = useState(() => new Set());
  const salaryHideTimersRef = useRef({});
  const revealSalaryFor = (id) => {
    setVisibleSalaryIds((prev) => new Set(prev).add(id));
    if (salaryHideTimersRef.current[id]) clearTimeout(salaryHideTimersRef.current[id]);
    salaryHideTimersRef.current[id] = setTimeout(() => {
      setVisibleSalaryIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 10000);
  };
  const longPressTimer = useRef(null);
  const partnerLogScrollRef = useRef(null);
  const [partnerTxnSubmitting, setPartnerTxnSubmitting] = useState(false);
  const [partnerTxnError, setPartnerTxnError] = useState('');

  // নোটিফিকেশন state
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotificationHistory, setShowNotificationHistory] = useState(false);
  const [notificationHistory, setNotificationHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // প্রোডাক্ট state
  const [showProductForm, setShowProductForm] = useState(false);
  const [products, setProducts] = useState([]);
  const [productForm, setProductForm] = useState({ name: '', sewing_price: '' });
  const [productSubmitting, setProductSubmitting] = useState(false);
  const [productError, setProductError] = useState('');
  const [editingProductId, setEditingProductId] = useState(null);
  const [applyPriceToExisting, setApplyPriceToExisting] = useState(false);

  // কারিগর হিসাব (প্রোডাকশন এন্ট্রি) state
  const [showKarigorHisab, setShowKarigorHisab] = useState(false);
  const [karigorStep, setKarigorStep] = useState('select-staff'); // select-staff | select-product | enter-qty
  const [karigorStaff, setKarigorStaff] = useState(null);
  const [karigorProduct, setKarigorProduct] = useState(null);
  const [karigorQty, setKarigorQty] = useState('');
  const [karigorEntryDate, setKarigorEntryDate] = useState('');
  const [karigorSubmitting, setKarigorSubmitting] = useState(false);
  const [karigorError, setKarigorError] = useState('');
  const [productionSummary, setProductionSummary] = useState({}); // { staffId: {total_quantity, total_amount} }
  const [recentProduction, setRecentProduction] = useState({}); // { staffId: entry } — গত ৩ ঘণ্টায় যোগ হওয়া
  const [editingProductionEntryId, setEditingProductionEntryId] = useState(null);

  // স্টাফের বিস্তারিত তথ্য (attendance + production + payments একসাথে)
  const [staffDetail, setStaffDetail] = useState(null); // { id, name, attendance, production, payments }
  const [staffDetailLoading, setStaffDetailLoading] = useState(false);
  const [detailView, setDetailView] = useState(null); // 'attendance' | 'production' | 'payments' | null
  const [detailList, setDetailList] = useState([]);
  const [detailListLoading, setDetailListLoading] = useState(false);

  // ফান্ড/খরচ state
  const [showFundChoice, setShowFundChoice] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expenseForm, setExpenseForm] = useState({ description: '', amount: '', expense_date: '' });
  const [expenseSubmitting, setExpenseSubmitting] = useState(false);
  const [expenseError, setExpenseError] = useState('');
  const [expenses, setExpenses] = useState([]);

  // মজুরী → খরচের বিস্তারিত (ফ্যাক্টরি খরচ + সব স্টাফ পেমেন্ট) — ক্যাশ মেমো স্টাইল
  const [showExpenseReport, setShowExpenseReport] = useState(false);
  const [expenseReportLoading, setExpenseReportLoading] = useState(false);
  const [allExpenses, setAllExpenses] = useState([]);
  const [allStaffPayments, setAllStaffPayments] = useState([]);
  const [allPartnerExpenses, setAllPartnerExpenses] = useState([]);

  const [showWeeklyPicker, setShowWeeklyPicker] = useState(false);
  const [weeklyStaff, setWeeklyStaff] = useState(null);
  const [weeklyAmount, setWeeklyAmount] = useState('');
  const [weeklyPaymentDate, setWeeklyPaymentDate] = useState('');
  const [weeklySubmitting, setWeeklySubmitting] = useState(false);
  const [weeklyError, setWeeklyError] = useState('');
  const [recentPayments, setRecentPayments] = useState({}); // { staffId: payment } — গত ৩ ঘণ্টায় দেওয়া
  const [editingPaymentId, setEditingPaymentId] = useState(null);

  // মোট ব্যালেন্স / বিস্তারিত / ক্যাশ মেমো state
  const [paymentsSummaryAll, setPaymentsSummaryAll] = useState({}); // { staffId: {total_paid} }
  const [salarySummaryAll, setSalarySummaryAll] = useState({}); // { staffId: {total_due} } — মাসিক বেতনের কারিগরদের জন্য
  const [previousBalanceAdjustments, setPreviousBalanceAdjustments] = useState({}); // { staffId: signedAmount } — আগের হিসাবের সমন্বয়

  // আগের হিসাব যোগ করুন state
  const [showPreviousBalancePage, setShowPreviousBalancePage] = useState(false);
  const [previousBalanceStaff, setPreviousBalanceStaff] = useState(null);
  const [previousBalanceDirection, setPreviousBalanceDirection] = useState(null); // 'staff_owed' | 'factory_owed'
  const [previousBalanceAmount, setPreviousBalanceAmount] = useState('');
  const [previousBalanceSubmitting, setPreviousBalanceSubmitting] = useState(false);
  const [previousBalanceError, setPreviousBalanceError] = useState('');

  // অর্ডার ম্যানেজমেন্ট — পেইজ যোগ করুন state
  const [showOrderPagesPage, setShowOrderPagesPage] = useState(false);
  const [orderPages, setOrderPages] = useState([]);
  const [newOrderPageName, setNewOrderPageName] = useState('');
  const [addingOrderPage, setAddingOrderPage] = useState(false);
  const [selectedOrderPage, setSelectedOrderPage] = useState(null);
  const [orderPageCredStatus, setOrderPageCredStatus] = useState([]);
  const [orderCredForm, setOrderCredForm] = useState({ steadfast_api_key: '', steadfast_secret_key: '', moderator_email: '', moderator_password: '' });
  const [aiCredList, setAiCredList] = useState([]);
  const [showAddAiForm, setShowAddAiForm] = useState(false);
  const [newAiProvider, setNewAiProvider] = useState('gemini');
  const [newAiApiKey, setNewAiApiKey] = useState('');
  const [savingNewAi, setSavingNewAi] = useState(false);
  const [aiCredError, setAiCredError] = useState('');
  const [savingOrderCred, setSavingOrderCred] = useState(false);
  const [orderCredError, setOrderCredError] = useState('');

  // অর্ডার ম্যানেজমেন্ট — মূল UI state
  const [showOrderManagementPage, setShowOrderManagementPage] = useState(false);
  const [orderMgmtView, setOrderMgmtView] = useState('groups'); // 'groups' | 'list'
  const [orderGroupTab, setOrderGroupTab] = useState('pending'); // 'pending' | 'emergency' | 'all_order'
  const [orderEntries, setOrderEntries] = useState([]);
  const [orderSearchQuery, setOrderSearchQuery] = useState('');
  const [showSaleSummaryPage, setShowSaleSummaryPage] = useState(false);
  const [saleSummaryPeriod, setSaleSummaryPeriod] = useState('single_day');
  const [saleSummaryDate, setSaleSummaryDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [saleSummaryCustomFrom, setSaleSummaryCustomFrom] = useState('');
  const [saleSummaryCustomTo, setSaleSummaryCustomTo] = useState('');
  const [saleSummaryData, setSaleSummaryData] = useState(null);
  const [saleSummaryLoading, setSaleSummaryLoading] = useState(false);
  const [orderEntriesLoading, setOrderEntriesLoading] = useState(false);
  const [orderCounts, setOrderCounts] = useState({});
  const [orderLastUpdated, setOrderLastUpdated] = useState(null);

  const [allOrderOffset, setAllOrderOffset] = useState(0);
  const [allOrderTotal, setAllOrderTotal] = useState(0);
  const [allOrderLoadingMore, setAllOrderLoadingMore] = useState(false);

  const [checkingFraudId, setCheckingFraudId] = useState(null);
  const [fraudResult, setFraudResult] = useState(null);
  const [courierSuccessResult, setCourierSuccessResult] = useState(null);
  const [courierErrorResult, setCourierErrorResult] = useState(null);
  const [trackingResult, setTrackingResult] = useState(null);
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [trackingError, setTrackingError] = useState('');

  const [showComposeOrder, setShowComposeOrder] = useState(false);
  const [composeOrderText, setComposeOrderText] = useState('');
  const [composeOrderImages, setComposeOrderImages] = useState([]);
  const [composeOrderPageId, setComposeOrderPageId] = useState(null);
  const [composeOrderSubmitting, setComposeOrderSubmitting] = useState(false);
  const [composeOrderError, setComposeOrderError] = useState('');
  const [duplicateOrderInfo, setDuplicateOrderInfo] = useState(null);
  const [viewingReactors, setViewingReactors] = useState(null);

  const [editingOrderEntry, setEditingOrderEntry] = useState(null);
  const [editOrderText, setEditOrderText] = useState('');
  const [savingOrderEdit, setSavingOrderEdit] = useState(false);

  const [deletingOrderEntry, setDeletingOrderEntry] = useState(null);
  const [deleteOrderPassword, setDeleteOrderPassword] = useState('');
  const [deleteOrderReason, setDeleteOrderReason] = useState('');
  const [deletingOrderSubmitting, setDeletingOrderSubmitting] = useState(false);
  const [deleteOrderError, setDeleteOrderError] = useState('');

  const [sendingCourierId, setSendingCourierId] = useState(null);
  const [orderActionError, setOrderActionError] = useState('');

  const [showOrderApprovalsPage, setShowOrderApprovalsPage] = useState(false);
  const [orderPendingEdits, setOrderPendingEdits] = useState([]);
  const [orderPendingDeletes, setOrderPendingDeletes] = useState([]);
  const [orderApprovalsLoading, setOrderApprovalsLoading] = useState(false);

  const [showBalanceDetail, setShowBalanceDetail] = useState(false);
  const [cashMemoStaff, setCashMemoStaff] = useState(null);
  const [cashMemoData, setCashMemoData] = useState(null); // { production: [], payments: [] }
  const [cashMemoLoading, setCashMemoLoading] = useState(false);
  const [sharingPDF, setSharingPDF] = useState(false);

  const fetchStaff = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/staff`);
      const data = await res.json();
      if (data.status === 'ok') {
        setStaffList(data.staff);
      }
    } catch (err) {
      console.error('স্টাফ লিস্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const [appWarmingUp, setAppWarmingUp] = useState(true);
  const [appConnectFailed, setAppConnectFailed] = useState(false);

  const warmUpAndLoad = async () => {
    setAppWarmingUp(true);
    setAppConnectFailed(false);
    // Railway-তে সার্ভার অলস থাকলে "ঘুমিয়ে" যেতে পারে, বা মাঝেমধ্যে ক্র্যাশ করে রিস্টার্ট হতে পারে —
    // দুই ক্ষেত্রেই প্রথম রিকোয়েস্টে সাড়া পেতে দেরি হয়। প্রতিটা চেষ্টায় সর্বোচ্চ ৫ সেকেন্ড অপেক্ষা করা
    // হচ্ছে (টাইমআউট সহ), যাতে সার্ভার পুরোপুরি বন্ধ থাকলে পেজ কয়েক মিনিট আটকে না থেকে দ্রুত
    // "সংযোগ করা যাচ্ছে না" দেখিয়ে দেয়।
    const warmUpBackend = async (retries = 5, timeoutMs = 5000) => {
      for (let i = 0; i < retries; i++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const res = await fetch(`${API_BASE}/api/staff`, { cache: 'no-store', signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) return true;
        } catch (err) {
          // সার্ভার এখনো জেগে ওঠেনি বা সাড়া দিচ্ছে না, একটু পর আবার চেষ্টা করা হবে
        }
      }
      return false;
    };

    const ok = await warmUpBackend();
    if (!ok) {
      setAppConnectFailed(true);
      setAppWarmingUp(false);
      return;
    }

    // মডারেটর লগইন করলে শুধু অর্ডার ম্যানেজমেন্টের "All Order Group" ছাড়া বাকি অ্যাপের
    // কোনো কিছুরই এক্সেস/ডেটা লাগবে না — তাই সরাসরি সেখানেই পাঠিয়ে দেওয়া হচ্ছে
    if (currentUser?.role === 'moderator') {
      await fetchOrderPages();
      setShowOrderManagementPage(true);
      openOrderGroup('all_order');
      setAppWarmingUp(false);
      return;
    }

    fetchStaff();
    fetchAttendanceToday();
    fetchProductionSummaryAll();
    fetchSyncInterval();
    fetchBalanceTrend();
    fetchUnreadCount();
    fetchDutySchedule();
    fetchPartners();
    fetchPreviousBalanceAdjustments();
    refreshMyProfile();
    setAppWarmingUp(false);
  };

  useEffect(() => {
    warmUpAndLoad();
  }, []);

  // মডারেটর যাতে কখনোই বাকি অ্যাপে (হোম/স্টাফ/হিসাব ইত্যাদি) পৌঁছাতে না পারে — ব্যাক বাটন চেপে
  // অর্ডার ম্যানেজমেন্ট থেকে বের হয়ে গেলেও সাথে সাথে আবার সেখানেই ফিরিয়ে আনা হবে
  useEffect(() => {
    if (currentUser?.role === 'moderator' && !appWarmingUp && !showOrderManagementPage) {
      setShowOrderManagementPage(true);
      if (orderMgmtView !== 'list' || orderGroupTab !== 'all_order') {
        openOrderGroup('all_order');
      }
    }
  }, [currentUser?.role, appWarmingUp, showOrderManagementPage]);

  // ফোনের ব্যাক বাটন চাপলে যেন পুরো অ্যাপ বন্ধ না হয়ে, শুধু সবশেষ খোলা মডাল/পেজটাই বন্ধ হয়ে
  // আগেরটায় ফিরে যায় (স্তরে স্তরে, একবারে সব বন্ধ না হয়ে)
  const modalRegistry = {
    showOrderPagesPage: [showOrderPagesPage, () => setShowOrderPagesPage(false)],
    showOrderManagementPage: [showOrderManagementPage, () => setShowOrderManagementPage(false)],
    showSaleSummaryPage: [showSaleSummaryPage, () => setShowSaleSummaryPage(false)],
    orderMgmtListView: [showOrderManagementPage && orderMgmtView === 'list', () => setOrderMgmtView('groups')],
    showComposeOrder: [showComposeOrder, () => setShowComposeOrder(false)],
    editingOrderEntry: [!!editingOrderEntry, () => setEditingOrderEntry(null)],
    deletingOrderEntry: [!!deletingOrderEntry, () => setDeletingOrderEntry(null)],
    showOrderApprovalsPage: [showOrderApprovalsPage, () => setShowOrderApprovalsPage(false)],
    courierSuccessResult: [!!courierSuccessResult, () => setCourierSuccessResult(null)],
    courierErrorResult: [!!courierErrorResult, () => setCourierErrorResult(null)],
    trackingModal: [!!(trackingResult || trackingLoading), () => { setTrackingResult(null); setTrackingLoading(false); }],
    duplicateOrderInfo: [!!duplicateOrderInfo, () => setDuplicateOrderInfo(null)],
    viewingReactors: [!!viewingReactors, () => setViewingReactors(null)],
    fraudResult: [!!fraudResult, () => setFraudResult(null)],
    selectedOrderPage: [!!selectedOrderPage, () => setSelectedOrderPage(null)],
    showPreviousBalancePage: [showPreviousBalancePage, () => setShowPreviousBalancePage(false)],
    previousBalanceStaff: [!!previousBalanceStaff, () => setPreviousBalanceStaff(null)],
    showManualAttendancePage: [showManualAttendancePage, () => setShowManualAttendancePage(false)],
    manualAttendanceStaff: [!!manualAttendanceStaff, () => setManualAttendanceStaff(null)],
    showWholesalerAccountSelectPage: [showWholesalerAccountSelectPage, () => setShowWholesalerAccountSelectPage(false)],
    deletingWholesalerId: [!!deletingWholesalerId, () => setDeletingWholesalerId(null)],
    selectedWholesalerForAccount: [!!selectedWholesalerForAccount, () => setSelectedWholesalerForAccount(null)],
    ledgerForm: [!!ledgerForm, () => setLedgerForm(null)],
    paymentForm: [!!paymentForm, () => setPaymentForm(null)],
    showProductRefList: [showProductRefList, () => setShowProductRefList(false)],
    showWholesalerLockPrompt: [showWholesalerLockPrompt, () => setShowWholesalerLockPrompt(false)],
    showWholesalerPage: [showWholesalerPage, () => setShowWholesalerPage(false)],
    showAddWholesalerForm: [showAddWholesalerForm, () => setShowAddWholesalerForm(false)],
    showWholesalerRatePage: [showWholesalerRatePage, () => setShowWholesalerRatePage(false)],
    showOvertimePage: [showOvertimePage, () => setShowOvertimePage(false)],
    overtimeStartSelect: [showOvertimePage && overtimeView === 'start-select', () => setOvertimeView('choose')],
    showOvertimeEndConfirm: [showOvertimeEndConfirm, () => setShowOvertimeEndConfirm(false)],
    staffDetail: [!!staffDetail, () => setStaffDetail(null)],
    showAbsentModal: [showAbsentModal, () => setShowAbsentModal(false)],
    showAddForm: [showAddForm, () => { setShowAddForm(false); setEditingStaffId(null); setForm({ name: '', phone: '', designation: '', joining_date: '', rate_type: 'piece', rate_amount: '', machine_user_id: '' }); }],
    showAttendanceModal: [showAttendanceModal, () => setShowAttendanceModal(false)],
    showBalanceDetail: [showBalanceDetail, () => setShowBalanceDetail(false)],
    showDutyForm: [showDutyForm, () => setShowDutyForm(false)],
    showEditProfile: [showEditProfile, () => setShowEditProfile(false)],
    showEmployeeModal: [showEmployeeModal, () => setShowEmployeeModal(false)],
    showExpenseForm: [showExpenseForm, () => setShowExpenseForm(false)],
    showExpenseReport: [showExpenseReport, () => setShowExpenseReport(false)],
    showFundChoice: [showFundChoice, () => setShowFundChoice(false)],
    showKarigorHisab: [showKarigorHisab, () => setShowKarigorHisab(false)],
    karigorStepProduct: [showKarigorHisab && karigorStep === 'select-product', () => setKarigorStep('select-staff')],
    karigorStepQty: [showKarigorHisab && karigorStep === 'enter-qty', () => setKarigorStep('select-product')],
    showMachineForm: [showMachineForm, () => setShowMachineForm(false)],
    showLateGraceForm: [showLateGraceForm, () => setShowLateGraceForm(false)],
    showNotificationHistory: [showNotificationHistory, () => setShowNotificationHistory(false)],
    showNotifications: [showNotifications, () => setShowNotifications(false)],
    showPartnerList: [showPartnerList, () => setShowPartnerList(false)],
    showPartnerLogPage: [showPartnerLogPage, () => setShowPartnerLogPage(false)],
    showPartnerResetConfirm: [showPartnerResetConfirm, () => setShowPartnerResetConfirm(false)],
    showPaymentResetConfirm: [showPaymentResetConfirm, () => setShowPaymentResetConfirm(false)],
    showProductForm: [showProductForm, () => setShowProductForm(false)],
    showProfileMenu: [showProfileMenu, () => setShowProfileMenu(false)],
    showResetConfirm: [showResetConfirm, () => setShowResetConfirm(false)],
    showUserManagement: [showUserManagement, () => setShowUserManagement(false)],
    showWeeklyPicker: [showWeeklyPicker, () => setShowWeeklyPicker(false)],
    weeklyPickerAmount: [showWeeklyPicker && !!weeklyStaff, () => setWeeklyStaff(null)],
    selectedPartner: [!!selectedPartner, () => setSelectedPartner(null)],
    partnerTxnForm: [!!partnerTxnForm, () => setPartnerTxnForm(null)],
    viewingReactorsTxn: [!!viewingReactorsTxn, () => setViewingReactorsTxn(null)],
    viewingFullImage: [!!viewingFullImage, () => setViewingFullImage(null)],
    detailView: [!!detailView, () => setDetailView(null)],
    cashMemoStaff: [!!cashMemoStaff, () => setCashMemoStaff(null)]
  };
  const currentOpenIds = Object.entries(modalRegistry).filter(([, [isOpen]]) => isOpen).map(([id]) => id);
  const openKey = currentOpenIds.join('|');
  const modalStackRef = useRef([]);

  // যা নতুন খুলেছে তা স্ট্যাকে যোগ + হিস্ট্রি এন্ট্রি পুশ করা, যা বন্ধ হয়ে গেছে (X বাটনে) তা স্ট্যাক থেকে সরানো
  useEffect(() => {
    const stack = modalStackRef.current;
    for (const id of currentOpenIds) {
      if (!stack.includes(id)) {
        stack.push(id);
        window.history.pushState({ modalId: id }, '');
      }
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      if (!currentOpenIds.includes(stack[i])) stack.splice(i, 1);
    }
  }, [openKey]);

  useEffect(() => {
    // অ্যাপ প্রথমবার লোড হওয়ার সময় একাধিক বাফার হিস্ট্রি এন্ট্রি — যাতে দ্রুত পরপর কয়েকবার
    // ব্যাক চাপলেও অ্যাপের বাইরে (আগে ব্রাউজারে যা খোলা ছিল সেখানে) চলে না যায়
    const HISTORY_BUFFER = 5;
    for (let i = 0; i < HISTORY_BUFFER; i++) {
      window.history.pushState({ appHome: true }, '');
    }

    const handlePopState = () => {
      const stack = modalStackRef.current;
      if (stack.length > 0) {
        const topId = stack.pop();
        const entry = modalRegistry[topId];
        if (entry) entry[1]();
      } else {
        // হোম স্ক্রিনে থাকা অবস্থায় ব্যাক চাপলে অ্যাপেই থাকতে হবে, বাইরে চলে যাওয়া যাবে না —
        // একাধিক বাফার এন্ট্রি আবার যোগ করে দেওয়া হচ্ছে, দ্রুত পরপর ব্যাক চাপার বিরুদ্ধে সুরক্ষার জন্য
        for (let i = 0; i < HISTORY_BUFFER; i++) {
          window.history.pushState({ appHome: true }, '');
        }
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // মেশিনে কেউ ফিঙ্গার দিলে অ্যাপ যেন নিজে থেকেই আপডেট দেখায়, ম্যানুয়াল রিলোড ছাড়াই —
  // ব্যাকএন্ডে যে সিঙ্ক ইন্টারভাল সেট করা আছে সেটার সাথে মিলিয়েই এখানে অটো-রিফ্রেশ হবে
  // (পার্টনার নোটিফিকেশনও এই একই ইন্টারভালে চেক হবে, প্রায় রিয়েল-টাইমের মতো)
  useEffect(() => {
    const seconds = Math.max(10, parseInt(syncInterval) || 30);
    const intervalId = setInterval(() => {
      fetchAttendanceToday();
      fetchStaff();
      fetchUnreadCount();
      fetchPartners();
      refreshMyProfile();
    }, seconds * 1000);
    return () => clearInterval(intervalId);
  }, [syncInterval]);

  // অন্য কোনো ডিভাইসে নিজের নাম/ছবি বদলানো হলে, এই ডিভাইসেও (উপরের পিরিয়ডিক সিঙ্কের মাধ্যমে)
  // সেটা এমনি এমনি আপডেট হয়ে যাবে — আবার লগইন করার দরকার নেই
  const refreshMyProfile = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders(), cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'ok') {
        onUpdateUser({ name: data.user.name, photo_url: data.user.photo_url });
      }
    } catch (err) {
      console.error('প্রোফাইল সিঙ্ক করতে সমস্যা হয়েছে:', err);
    }
  };

  const fetchAttendanceToday = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/attendance/today`);
      const data = await res.json();
      if (data.status === 'ok') {
        setAttendanceToday(data.staff);
        setLastUpdatedAt(new Date());
      }
    } catch (err) {
      console.error('আজকের উপস্থিতি আনতে সমস্যা হয়েছে:', err);
    }
  };

  const fetchBalanceTrend = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/balance/trend`);
      const data = await res.json();
      if (data.status === 'ok') {
        setBalanceTrend({ percent_change: data.percent_change, direction: data.direction });
      }
    } catch (err) {
      console.error('ব্যালেন্স ট্রেন্ড আনতে সমস্যা হয়েছে:', err);
    }
  };

  const fetchDutySchedule = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/duty-schedule`);
      const data = await res.json();
      if (data.status === 'ok' && data.schedule) {
        setDutyForm({
          shift1_start: data.schedule.shift1_start?.slice(0, 5) || '09:00',
          shift1_end: data.schedule.shift1_end?.slice(0, 5) || '14:00',
          shift2_start: data.schedule.shift2_start?.slice(0, 5) || '15:00',
          shift2_end: data.schedule.shift2_end?.slice(0, 5) || '22:00'
        });
      }
    } catch (err) {
      console.error('ডিউটি টাইম আনতে সমস্যা হয়েছে:', err);
    }
  };

  const fetchMachines = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/machines`);
      const data = await res.json();
      if (data.status === 'ok') setMachines(data.machines);
    } catch (err) {
      console.error('মেশিন লিস্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const fetchSyncInterval = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings/sync-interval`);
      const data = await res.json();
      if (data.status === 'ok') setSyncInterval(String(data.sync_interval_seconds));
    } catch (err) {
      console.error('সিঙ্ক ইন্টারভাল আনতে সমস্যা হয়েছে:', err);
    }
  };

  const saveSyncInterval = async () => {
    setSyncIntervalSaving(true);
    setSyncIntervalSaved(false);
    try {
      const res = await fetch(`${API_BASE}/api/settings/sync-interval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: parseInt(syncInterval) })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setSyncInterval(String(data.sync_interval_seconds));
        setSyncIntervalSaved(true);
        setTimeout(() => setSyncIntervalSaved(false), 2000);
      }
    } catch (err) {
      console.error('সিঙ্ক ইন্টারভাল সেভ করতে সমস্যা হয়েছে:', err);
    } finally {
      setSyncIntervalSaving(false);
    }
  };

  const openLateGraceForm = () => {
    setShowLateGraceForm(true);
    fetchLateGrace();
  };

  const fetchLateGrace = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/settings/late-grace`, { headers: authHeaders() });
      const data = await res.json();
      if (data.status === 'ok') setLateGraceMinutes(String(data.late_grace_minutes));
    } catch (err) {
      console.error('লেট গ্রেস টাইম আনতে সমস্যা হয়েছে:', err);
    }
  };

  const saveLateGrace = async () => {
    setLateGraceSaving(true);
    setLateGraceSaved(false);
    try {
      const res = await fetch(`${API_BASE}/api/settings/late-grace`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ minutes: parseInt(lateGraceMinutes) })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setLateGraceMinutes(String(data.late_grace_minutes));
        setLateGraceSaved(true);
        setTimeout(() => setLateGraceSaved(false), 2000);
      }
    } catch (err) {
      console.error('লেট গ্রেস টাইম সেভ করতে সমস্যা হয়েছে:', err);
    } finally {
      setLateGraceSaving(false);
    }
  };

  const openAttendanceModal = () => {
    setShowAttendanceModal(true);
    fetchAttendanceToday();
  };

  const openAbsentModal = () => {
    setShowAbsentModal(true);
    fetchAttendanceToday();
  };

  const confirmResetAttendance = async () => {
    setResetError('');
    if (resetPasswordInput !== 'Maya') {
      setResetError('পাসওয়ার্ড ভুল');
      return;
    }
    setResetSubmitting(true);
    try {
      await fetch(`${API_BASE}/api/attendance/clear-today`, { method: 'DELETE', headers: authHeaders() });
      fetchAttendanceToday();
      setShowResetConfirm(false);
      setResetPasswordInput('');
    } catch (err) {
      setResetError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setResetSubmitting(false);
    }
  };

  const confirmPaymentReset = async () => {
    setPaymentResetError('');
    if (paymentResetPasswordInput !== 'Maya') {
      setPaymentResetError('পাসওয়ার্ড ভুল');
      return;
    }
    setPaymentResetSubmitting(true);
    try {
      await fetch(`${API_BASE}/api/staff-payments/clear-all`, { method: 'DELETE', headers: authHeaders() });
      setShowPaymentResetConfirm(false);
      setPaymentResetPasswordInput('');
      // খরচের বিস্তারিত রিপোর্ট এবং পাওনার হিসাব খোলা থাকলে সাথে সাথে আপডেট দেখানো
      setAllStaffPayments([]);
      fetchPaymentsSummaryAll();
    } catch (err) {
      setPaymentResetError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setPaymentResetSubmitting(false);
    }
  };

  const confirmPartnerReset = async () => {
    setPartnerResetError('');
    if (partnerResetPasswordInput !== 'Maya') {
      setPartnerResetError('পাসওয়ার্ড ভুল');
      return;
    }
    setPartnerResetSubmitting(true);
    try {
      await fetch(`${API_BASE}/api/partners/clear-all`, { method: 'DELETE', headers: authHeaders() });
      setShowPartnerResetConfirm(false);
      setPartnerResetPasswordInput('');
      // সব জায়গায় সাথে সাথে খালি দেখানো — পার্টনার ডিটেইল, খরচের বিস্তারিত, নোটিফিকেশন
      setPartnerTransactions([]);
      setPartnerSummary(null);
      setAllPartnerExpenses([]);
      setNotifications([]);
      setUnreadCount(0);
    } catch (err) {
      setPartnerResetError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setPartnerResetSubmitting(false);
    }
  };

  // স্টাফের নামে ক্লিক করলে এই ফাংশন attendance + production + payment তিনটাই একসাথে টেনে আনে
  const openStaffDetail = async (staffId, name) => {
    setDetailView(null);
    setDetailList([]);
    const staffRecord = staffList.find((x) => x.id === staffId) || { name };
    setStaffDetail({ ...staffRecord, id: staffId, name: staffRecord.name || name, attendance: null, production: null, payments: null, salary: null });
    setStaffDetailLoading(true);
    try {
      const isMonthly = staffRecord.rate_type === 'monthly';
      const [attRes, prodRes, payRes, salRes] = await Promise.all([
        fetch(`${API_BASE}/api/attendance/summary/${staffId}?days=30`),
        fetch(`${API_BASE}/api/production/staff/${staffId}/summary`),
        fetch(`${API_BASE}/api/staff-payments/staff/${staffId}/summary`),
        isMonthly ? fetch(`${API_BASE}/api/salary/staff/${staffId}/summary?days=30`) : Promise.resolve(null)
      ]);
      const attData = await attRes.json();
      const prodData = await prodRes.json();
      const payData = await payRes.json();
      const salData = salRes ? await salRes.json() : null;
      setStaffDetail({
        ...staffRecord,
        id: staffId,
        name: staffRecord.name || name,
        attendance: attData.status === 'ok' ? attData.summary : null,
        production: prodData.status === 'ok' ? prodData.summary : null,
        payments: payData.status === 'ok' ? payData.summary : null,
        salary: salData && salData.status === 'ok' ? salData.salary : null
      });
    } catch (err) {
      console.error('বিস্তারিত তথ্য আনতে সমস্যা হয়েছে:', err);
    } finally {
      setStaffDetailLoading(false);
    }
  };

  // যেকোনো বক্সে ক্লিক করলে সেই ক্যাটাগরির বিস্তারিত লিস্ট টেনে আনে
  const openDetailView = async (view) => {
    setDetailView(view);
    setDetailListLoading(true);
    setDetailList([]);
    try {
      let url = '';
      if (view === 'attendance') url = `${API_BASE}/api/attendance/daily/${staffDetail.id}?days=30`;
      if (view === 'production') url = `${API_BASE}/api/production/staff/${staffDetail.id}`;
      if (view === 'payments') url = `${API_BASE}/api/staff-payments/staff/${staffDetail.id}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'ok') {
        setDetailList(data.days || data.entries || data.payments || []);
      }
    } catch (err) {
      console.error('বিস্তারিত লিস্ট আনতে সমস্যা হয়েছে:', err);
    } finally {
      setDetailListLoading(false);
    }
  };

  const fetchProductionSummaryAll = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/production/summary-all`);
      const data = await res.json();
      if (data.status === 'ok') {
        const map = {};
        for (const row of data.summary) map[row.staff_id] = row;
        setProductionSummary(map);
      }
    } catch (err) {
      console.error('প্রোডাকশন সামারি আনতে সমস্যা হয়েছে:', err);
    }
  };

  const fetchPaymentsSummaryAll = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/staff-payments/summary-all`);
      const data = await res.json();
      if (data.status === 'ok') {
        const map = {};
        for (const row of data.summary) map[row.staff_id] = row;
        setPaymentsSummaryAll(map);
        return map;
      }
    } catch (err) {
      console.error('পেমেন্ট সামারি আনতে সমস্যা হয়েছে:', err);
    }
    return {};
  };

  const fetchSalarySummaryAll = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/salary/summary-all`);
      const data = await res.json();
      if (data.status === 'ok') {
        const map = {};
        for (const row of data.summary) map[row.staff_id] = row;
        setSalarySummaryAll(map);
        return map;
      }
    } catch (err) {
      console.error('বেতন সামারি আনতে সমস্যা হয়েছে:', err);
    }
    return {};
  };

  const fetchPreviousBalanceAdjustments = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/staff/balance-adjustments/summary`, { cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'ok') {
        setPreviousBalanceAdjustments(data.adjustments);
        return data.adjustments;
      }
    } catch (err) {
      console.error('আগের হিসাবের সমন্বয় আনতে সমস্যা হয়েছে:', err);
    }
    return {};
  };

  const openPreviousBalancePage = () => {
    setShowPreviousBalancePage(true);
    fetchPreviousBalanceAdjustments();
  };

  const selectPreviousBalanceStaff = (s) => {
    setPreviousBalanceStaff(s);
    setPreviousBalanceDirection(null);
    setPreviousBalanceAmount('');
    setPreviousBalanceError('');
  };

  const submitPreviousBalance = async () => {
    setPreviousBalanceError('');
    if (!previousBalanceDirection) {
      setPreviousBalanceError('কারিগর পাবে নাকি আপনি পাবেন সেটা বেছে নিতে হবে');
      return;
    }
    if (!previousBalanceAmount || parseFloat(previousBalanceAmount) <= 0) {
      setPreviousBalanceError('টাকার পরিমাণ দিতে হবে');
      return;
    }
    setPreviousBalanceSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/staff/${previousBalanceStaff.id}/balance-adjustments`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          amount: previousBalanceAmount,
          direction: previousBalanceDirection,
          note: 'আগের হিসাবের আপডেট'
        })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setPreviousBalanceStaff(null);
        fetchPreviousBalanceAdjustments();
        fetchSalarySummaryAll();
      } else {
        setPreviousBalanceError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setPreviousBalanceError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setPreviousBalanceSubmitting(false);
    }
  };

  // ==================== অর্ডার ম্যানেজমেন্ট — পেইজ ও ক্রেডেনশিয়াল ====================

  const openOrderPagesPage = () => {
    setShowOrderPagesPage(true);
    fetchOrderPages();
  };

  const fetchOrderPages = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/order-pages`, { cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'ok') setOrderPages(data.pages);
    } catch (err) {
      console.error('পেইজ লিস্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const submitNewOrderPage = async () => {
    if (!newOrderPageName.trim()) return;
    setAddingOrderPage(true);
    try {
      const res = await fetch(`${API_BASE}/api/order-pages`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: newOrderPageName })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setNewOrderPageName('');
        fetchOrderPages();
      } else {
        alert(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      alert('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setAddingOrderPage(false);
    }
  };

  const selectOrderPage = async (page) => {
    setSelectedOrderPage(page);
    setOrderCredForm({ steadfast_api_key: '', steadfast_secret_key: '', moderator_email: '', moderator_password: '' });
    setOrderCredError('');
    try {
      const res = await fetch(`${API_BASE}/api/order-pages/${page.id}/credentials`, {
        headers: authHeaders(),
        cache: 'no-store'
      });
      const data = await res.json();
      if (data.status === 'ok') setOrderPageCredStatus(data.credentials);
    } catch (err) {
      console.error('ক্রেডেনশিয়াল স্ট্যাটাস আনতে সমস্যা হয়েছে:', err);
    }
    fetchAiCredList(page.id);
  };

  const fetchAiCredList = async (pageId) => {
    try {
      const res = await fetch(`${API_BASE}/api/order-pages/${pageId}/ai-credentials`, {
        headers: authHeaders(),
        cache: 'no-store'
      });
      const data = await res.json();
      if (data.status === 'ok') setAiCredList(data.credentials);
    } catch (err) {
      console.error('AI ক্রেডেনশিয়াল লিস্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const submitNewAiCred = async () => {
    setAiCredError('');
    if (!newAiApiKey.trim()) {
      setAiCredError('API Key দিতে হবে');
      return;
    }
    if (aiCredList.length >= 5) {
      setAiCredError('সর্বোচ্চ ৫টা AI যোগ করা যাবে');
      return;
    }
    setSavingNewAi(true);
    try {
      const res = await fetch(`${API_BASE}/api/order-pages/${selectedOrderPage.id}/ai-credentials`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ provider: newAiProvider, api_key: newAiApiKey })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setNewAiApiKey('');
        setShowAddAiForm(false);
        fetchAiCredList(selectedOrderPage.id);
      } else {
        setAiCredError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setAiCredError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setSavingNewAi(false);
    }
  };

  const deleteAiCred = async (credId) => {
    try {
      await fetch(`${API_BASE}/api/order-pages/${selectedOrderPage.id}/ai-credentials/${credId}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      fetchAiCredList(selectedOrderPage.id);
    } catch (err) {
      console.error('AI ক্রেডেনশিয়াল মুছতে সমস্যা হয়েছে:', err);
    }
  };

  const aiProviderLabel = (provider) => (provider === 'gemini' ? 'Gemini' : provider === 'openai' ? 'ChatGPT (OpenAI)' : provider === 'claude' ? 'Claude (Anthropic)' : provider);

  const isOrderCredSet = (type, provider, field) => {
    const row = orderPageCredStatus.find((c) => c.type === type && c.provider === provider);
    if (!row) return false;
    return field === 'api_key' ? row.has_api_key : row.has_secret_key;
  };

  const submitOrderCredentials = async () => {
    setOrderCredError('');
    setSavingOrderCred(true);
    try {
      const calls = [];
      if (orderCredForm.steadfast_api_key || orderCredForm.steadfast_secret_key) {
        calls.push(
          fetch(`${API_BASE}/api/order-pages/${selectedOrderPage.id}/credentials`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
              type: 'courier',
              provider: 'steadfast',
              api_key: orderCredForm.steadfast_api_key || undefined,
              secret_key: orderCredForm.steadfast_secret_key || undefined
            })
          })
        );
      }
      if (orderCredForm.moderator_email || orderCredForm.moderator_password) {
        calls.push(
          fetch(`${API_BASE}/api/order-pages/${selectedOrderPage.id}/credentials`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
              type: 'courier_moderator',
              provider: 'steadfast',
              api_key: orderCredForm.moderator_email || undefined,
              secret_key: orderCredForm.moderator_password || undefined
            })
          })
        );
      }
      if (calls.length === 0) {
        setOrderCredError('অন্তত একটা ফিল্ড পূরণ করুন');
        setSavingOrderCred(false);
        return;
      }
      await Promise.all(calls);
      setOrderCredForm({ steadfast_api_key: '', steadfast_secret_key: '', moderator_email: '', moderator_password: '' });
      selectOrderPage(selectedOrderPage);
    } catch (err) {
      setOrderCredError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setSavingOrderCred(false);
    }
  };

  // ==================== অর্ডার ম্যানেজমেন্ট — মূল ফাংশন ====================

  const openOrderManagementPage = () => {
    setShowOrderManagementPage(true);
    setOrderMgmtView('groups');
    fetchOrderCounts();
    if (orderPages.length === 0) fetchOrderPages();
  };

  const fetchOrderEntries = async (group) => {
    setOrderEntriesLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/order-entries?group=${group}`, { headers: authHeaders(), cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'ok') setOrderEntries(data.entries);
      setOrderLastUpdated(new Date());
    } catch (err) {
      console.error('অর্ডার লিস্ট আনতে সমস্যা হয়েছে:', err);
    } finally {
      setOrderEntriesLoading(false);
    }
  };

  const fetchAllOrderPage = async (offset) => {
    if (offset === 0) setOrderEntriesLoading(true);
    else setAllOrderLoadingMore(true);
    try {
      const res = await fetch(`${API_BASE}/api/order-entries/all-order-page?offset=${offset}&limit=20`, {
        headers: authHeaders(),
        cache: 'no-store'
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setOrderEntries((prev) => (offset === 0 ? data.entries : [...prev, ...data.entries]));
        setAllOrderTotal(data.total);
        setAllOrderOffset(offset + data.entries.length);
      }
      setOrderLastUpdated(new Date());
    } catch (err) {
      console.error('All Order লিস্ট আনতে সমস্যা হয়েছে:', err);
    } finally {
      setOrderEntriesLoading(false);
      setAllOrderLoadingMore(false);
    }
  };

  const fetchOrderCounts = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/order-entries/counts`, { headers: authHeaders(), cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'ok') setOrderCounts(data.counts);
    } catch (err) {
      console.error('অর্ডার কাউন্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const refreshOrderList = () => {
    if (orderGroupTab === 'all_order') {
      setAllOrderOffset(0);
      fetchAllOrderPage(0);
    } else {
      fetchOrderEntries(orderGroupTab);
    }
    fetchOrderCounts();
  };

  const openSaleSummaryPage = () => {
    setShowSaleSummaryPage(true);
    const d = new Date();
    const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setSaleSummaryPeriod('single_day');
    setSaleSummaryDate(todayStr);
    fetchSaleSummary('single_day', { date: todayStr });
  };

  const fetchSaleSummary = async (period, params = {}) => {
    setSaleSummaryLoading(true);
    try {
      const qs = new URLSearchParams({ period, ...params }).toString();
      const res = await fetch(`${API_BASE}/api/order-entries/sale-summary?${qs}`, {
        headers: authHeaders(),
        cache: 'no-store'
      });
      const data = await res.json();
      if (data.status === 'ok') setSaleSummaryData(data.summary);
    } catch (err) {
      console.error('সেল সামারি আনতে সমস্যা হয়েছে:', err);
    } finally {
      setSaleSummaryLoading(false);
    }
  };

  const switchSaleSummaryPeriod = (period) => {
    setSaleSummaryPeriod(period);
    fetchSaleSummary(period);
  };

  // < > বাটন দিয়ে একদিন করে পিছনে/সামনে যাওয়ার জন্য
  const shiftSaleSummaryDate = (deltaDays) => {
    const [y, m, d] = saleSummaryDate.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d));
    dateObj.setUTCDate(dateObj.getUTCDate() + deltaDays);
    const newDateStr = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dateObj.getUTCDate()).padStart(2, '0')}`;
    setSaleSummaryDate(newDateStr);
    setSaleSummaryPeriod('single_day');
    fetchSaleSummary('single_day', { date: newDateStr });
  };

  const applySaleSummaryCustomRange = () => {
    if (!saleSummaryCustomFrom || !saleSummaryCustomTo) return;
    setSaleSummaryPeriod('custom');
    fetchSaleSummary('custom', { from: saleSummaryCustomFrom, to: saleSummaryCustomTo });
  };

  // ফোন নাম্বার/অর্ডার নাম্বার/পার্সেল আইডি/টেক্সট দিয়ে অর্ডার খোঁজার জন্য
  const matchesOrderSearch = (entry) => {
    const q = orderSearchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      String(entry.id).includes(q) ||
      (entry.order_number != null && String(entry.order_number).includes(q)) ||
      (entry.customer_phone || '').toLowerCase().includes(q) ||
      (entry.consignment_id || '').toString().toLowerCase().includes(q) ||
      (entry.tracking_code || '').toLowerCase().includes(q) ||
      (entry.raw_text || '').toLowerCase().includes(q)
    );
  };

  const openOrderGroup = (group) => {
    setOrderGroupTab(group);
    setOrderMgmtView('list');
    setOrderSearchQuery('');
    if (group === 'all_order') {
      setAllOrderOffset(0);
      fetchAllOrderPage(0);
    } else {
      fetchOrderEntries(group);
    }
  };

  // Steadfast কখনো সরাসরি success_ratio না দিলে, মোট আর ডেলিভার সংখ্যা থেকে নিজে হিসাব করে বের করা হচ্ছে
  const computeSuccessRatio = (fraud) => {
    if (fraud.success_ratio !== undefined && fraud.success_ratio !== null) return fraud.success_ratio;
    if (fraud.total_parcels > 0 && fraud.total_delivered !== undefined) {
      return Math.round((fraud.total_delivered / fraud.total_parcels) * 100);
    }
    return '—';
  };

  // অর্ডারে ❤️ লাভ রিয়েক্ট দেওয়া/তুলে নেওয়ার জন্য — যেহেতু batch_id দিয়ে সেভ হয়, এই লিস্টের সব কপিতেও
  // (একই batch_id-এর) সাথে সাথে আপডেট হয়ে যাবে
  const toggleOrderReaction = async (entry) => {
    // তাৎক্ষণিক UI আপডেট (অপটিমিস্টিক), তারপর সার্ভার কনফার্ম করলে সঠিক সংখ্যা বসবে
    const optimisticReacted = !entry.reacted_by_me;
    const optimisticCount = entry.reaction_count + (optimisticReacted ? 1 : -1);
    setOrderEntries((prev) =>
      prev.map((e) =>
        e.batch_id === entry.batch_id
          ? { ...e, reacted_by_me: optimisticReacted, reaction_count: optimisticCount }
          : e
      )
    );
    try {
      const res = await fetch(`${API_BASE}/api/order-entries/${entry.id}/react`, {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setOrderEntries((prev) =>
          prev.map((e) =>
            e.batch_id === entry.batch_id
              ? { ...e, reacted_by_me: data.reacted_by_me, reaction_count: data.reaction_count, reactors: data.reactors }
              : e
          )
        );
      }
    } catch (err) {
      console.error('রিয়েক্ট দিতে সমস্যা হয়েছে:', err);
    }
  };

  const checkOrderFraud = async (entry) => {
    // raw_text থেকে ফোন নাম্বার বের করার চেষ্টা
    const phoneMatch = (entry.customer_phone) || (entry.raw_text.match(/(01[3-9]\d{8})/) || [])[0];
    if (!phoneMatch) {
      alert('এই অর্ডারে ফোন নাম্বার খুঁজে পাওয়া যায়নি');
      return;
    }
    setCheckingFraudId(entry.id);
    try {
      const res = await fetch(
        `${API_BASE}/api/order-entries/fraud-check-phone?phone=${phoneMatch}&page_id=${entry.page_id || ''}&entry_id=${entry.id}`,
        { headers: authHeaders() }
      );
      const data = await res.json();
      if (data.status === 'ok') {
        setFraudResult({ phone: phoneMatch, ...data.result });
        // কার্ডেই স্থায়ীভাবে দেখানোর জন্য লিস্টের এই এন্ট্রিটাও সাথে সাথে আপডেট করা হচ্ছে
        setOrderEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, fraud_check_result: data.result } : e)));
      } else {
        alert(data.message || 'ফ্রড চেক করা যায়নি');
      }
    } catch (err) {
      alert('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setCheckingFraudId(null);
    }
  };

  const openComposeOrder = () => {
    setComposeOrderText('');
    setComposeOrderImages([]);
    setComposeOrderPageId(null);
    setComposeOrderError('');
    setShowComposeOrder(true);
  };

  const handleComposeOrderImageChange = (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const maxSize = 1000;
          let { width, height } = img;
          if (width > height) {
            if (width > maxSize) { height = Math.round(height * (maxSize / width)); width = maxSize; }
          } else {
            if (height > maxSize) { width = Math.round(width * (maxSize / height)); height = maxSize; }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          const compressed = canvas.toDataURL('image/jpeg', 0.85);
          setComposeOrderImages((prev) => [...prev, compressed]);
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  };

  const removeComposeOrderImage = (idx) => {
    setComposeOrderImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const submitComposeOrder = async (force = false) => {
    setComposeOrderError('');
    if (!composeOrderPageId) {
      setComposeOrderError('কোন পেইজের অর্ডার সেটা বাছাই করতে হবে');
      return;
    }
    if (!composeOrderText.trim()) {
      setComposeOrderError('অর্ডারের তথ্য লিখতে হবে');
      return;
    }
    if (!/(01[3-9]\d{8})/.test(composeOrderText)) {
      setComposeOrderError('ফোন নাম্বার ছাড়া পোস্ট করা যাবে না — একটা সঠিক ফোন নাম্বার (01XXXXXXXXX) যোগ করুন');
      return;
    }
    setComposeOrderSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/order-entries`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ raw_text: composeOrderText, image_urls: composeOrderImages, page_id: composeOrderPageId, force })
      });
      const data = await res.json();
      if (data.status === 'duplicate_found') {
        setDuplicateOrderInfo(data.existing_order);
      } else if (data.status === 'ok') {
        setShowComposeOrder(false);
        setDuplicateOrderInfo(null);
        refreshOrderList();
      } else {
        setComposeOrderError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setComposeOrderError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setComposeOrderSubmitting(false);
    }
  };

  const openEditOrder = (entry) => {
    setEditingOrderEntry(entry);
    setEditOrderText(entry.raw_text);
  };

  const submitEditOrder = async () => {
    setSavingOrderEdit(true);
    try {
      const res = await fetch(`${API_BASE}/api/order-entries/${editingOrderEntry.id}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ raw_text: editOrderText, image_urls: editingOrderEntry.image_urls })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setEditingOrderEntry(null);
        alert(data.message);
        refreshOrderList();
      } else {
        alert(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      alert('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setSavingOrderEdit(false);
    }
  };

  const openDeleteOrder = (entry) => {
    setDeletingOrderEntry(entry);
    setDeleteOrderPassword('');
    setDeleteOrderReason('');
    setDeleteOrderError('');
  };

  const submitDeleteOrder = async () => {
    setDeleteOrderError('');
    if (currentUser?.role !== 'admin' && !deleteOrderReason.trim()) {
      setDeleteOrderError('কেন ডিলিট করতে চাচ্ছেন সেটা লিখতে হবে');
      return;
    }
    setDeletingOrderSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/order-entries/${deletingOrderEntry.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ password: deleteOrderPassword, reason: deleteOrderReason })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setDeletingOrderEntry(null);
        refreshOrderList();
      } else {
        setDeleteOrderError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setDeleteOrderError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setDeletingOrderSubmitting(false);
    }
  };

  const sendOrderToCourier = async (entry) => {
    setOrderActionError('');
    setSendingCourierId(entry.id);
    try {
      const res = await fetch(`${API_BASE}/api/order-entries/${entry.id}/send-courier`, {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setCourierSuccessResult({
          entry: {
            ...entry,
            status: 'sent',
            consignment_id: data.consignment_id,
            amount: data.amount,
            customer_name: data.customer_name,
            customer_phone: data.customer_phone
          },
          consignment_id: data.consignment_id,
          tracking_code: data.tracking_code
        });
        refreshOrderList();
      } else {
        setCourierErrorResult({ entry, message: data.message || 'কুরিয়ারে পাঠাতে সমস্যা হয়েছে' });
      }
    } catch (err) {
      setCourierErrorResult({ entry, message: 'সার্ভারের সাথে কানেক্ট করা যায়নি' });
    } finally {
      setSendingCourierId(null);
    }
  };

  const openTracking = async (entry) => {
    setTrackingResult(null);
    setTrackingError('');
    setTrackingLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/order-entries/${entry.id}/tracking`, { headers: authHeaders() });
      const data = await res.json();
      if (data.status === 'ok') {
        setTrackingResult({ entry, ...data.tracking });
      } else {
        setTrackingError(data.message || 'ট্র্যাকিং আনা যায়নি');
        setTrackingResult({ entry, error: true });
      }
    } catch (err) {
      setTrackingError('সার্ভারের সাথে কানেক্ট করা যায়নি');
      setTrackingResult({ entry, error: true });
    } finally {
      setTrackingLoading(false);
    }
  };

  const sendOrderToEmergency = async (entry) => {
    try {
      const res = await fetch(`${API_BASE}/api/order-entries/${entry.id}/emergency`, {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await res.json();
      if (data.status === 'ok') {
        alert(data.message);
        fetchOrderCounts();
      } else {
        alert(data.message || 'Emergency-তে যোগ করতে সমস্যা হয়েছে');
      }
    } catch (err) {
      console.error('Emergency-তে যোগ করতে সমস্যা হয়েছে:', err);
      alert('সার্ভারের সাথে কানেক্ট করা যায়নি');
    }
  };

  const openOrderApprovalsPage = () => {
    setShowOrderApprovalsPage(true);
    fetchOrderApprovals();
  };

  const fetchOrderApprovals = async () => {
    setOrderApprovalsLoading(true);
    try {
      const [editsRes, deletesRes] = await Promise.all([
        fetch(`${API_BASE}/api/order-entries/pending-edits`, { headers: authHeaders(), cache: 'no-store' }),
        fetch(`${API_BASE}/api/order-entries/pending-deletes`, { headers: authHeaders(), cache: 'no-store' })
      ]);
      const editsData = await editsRes.json();
      const deletesData = await deletesRes.json();
      if (editsData.status === 'ok') setOrderPendingEdits(editsData.pending_edits);
      if (deletesData.status === 'ok') setOrderPendingDeletes(deletesData.pending_deletes);
    } catch (err) {
      console.error('অনুমোদনের লিস্ট আনতে সমস্যা হয়েছে:', err);
    } finally {
      setOrderApprovalsLoading(false);
    }
  };

  const approveOrderEdit = async (id) => {
    try {
      await fetch(`${API_BASE}/api/order-entries/pending-edits/${id}/approve`, { method: 'POST', headers: authHeaders() });
      fetchOrderApprovals();
    } catch (err) {
      console.error('এডিট অনুমোদন করতে সমস্যা হয়েছে:', err);
    }
  };

  const declineOrderEdit = async (id) => {
    try {
      await fetch(`${API_BASE}/api/order-entries/pending-edits/${id}/decline`, { method: 'POST', headers: authHeaders() });
      fetchOrderApprovals();
    } catch (err) {
      console.error('এডিট বাতিল করতে সমস্যা হয়েছে:', err);
    }
  };

  const approveOrderDelete = async (id) => {
    try {
      await fetch(`${API_BASE}/api/order-entries/pending-deletes/${id}/approve`, { method: 'POST', headers: authHeaders() });
      fetchOrderApprovals();
      fetchOrderCounts();
    } catch (err) {
      console.error('ডিলিট অনুমোদন করতে সমস্যা হয়েছে:', err);
    }
  };

  const declineOrderDelete = async (id) => {
    try {
      await fetch(`${API_BASE}/api/order-entries/pending-deletes/${id}/decline`, { method: 'POST', headers: authHeaders() });
      fetchOrderApprovals();
    } catch (err) {
      console.error('ডিলিট বাতিল করতে সমস্যা হয়েছে:', err);
    }
  };

  // একজন কারিগর এখন কত টাকা পাবে সেটা বের করে
  // মাসিক বেতনের কারিগর: শুক্রবার বেতনসহ ছুটি + উপস্থিত দিনের বেতন − লেট কাটা − অনুপস্থিত কাটা − দেওয়া টাকা (± আগের হিসাব)
  // প্রোডাকশনের কারিগর: মোট আয় − দেওয়া টাকা (± আগের হিসাব)
  const computeStaffDue = (s, paymentsMap, salaryMap, adjustmentsMap) => {
    const paidMap = paymentsMap || paymentsSummaryAll;
    const salMap = salaryMap || salarySummaryAll;
    const adjMap = adjustmentsMap || previousBalanceAdjustments;
    const adjustment = parseFloat(adjMap[s.id] || 0);
    if (s.rate_type === 'monthly') {
      if (salMap[s.id]) return parseFloat(salMap[s.id].total_due); // ব্যাকএন্ডেই আগের হিসাব যুক্ত করা আছে
      // সালারি সামারি এখনো লোড না হলে সাধারণ হিসাব (fallback)
      const paid = parseFloat(paidMap[s.id]?.total_paid || 0);
      return parseFloat(s.rate_amount || 0) - paid + adjustment;
    }
    const earned = parseFloat(productionSummary[s.id]?.total_amount || 0);
    const paid = parseFloat(paidMap[s.id]?.total_paid || 0);
    return earned - paid + adjustment;
  };

  const handleShowBalance = async () => {
    if (balanceHidden) {
      await fetchPaymentsSummaryAll();
      await fetchProductionSummaryAll();
      await fetchSalarySummaryAll();
    }
    setBalanceHidden(!balanceHidden);
  };

  const handleShowBalanceDetail = async () => {
    await fetchPaymentsSummaryAll();
    await fetchProductionSummaryAll();
    await fetchSalarySummaryAll();
    setShowBalanceDetail(true);
  };

  // কারিগরের ক্যাশ মেমো (রশিদ) — প্রোডাকশন/বেতনের বিস্তারিত + পেমেন্ট হিস্ট্রি একসাথে
  const openCashMemo = async (staff) => {
    setCashMemoStaff(staff);
    setCashMemoLoading(true);
    setCashMemoData(null);
    try {
      const isMonthly = staff.rate_type === 'monthly';
      const [prodRes, payRes, salRes] = await Promise.all([
        fetch(`${API_BASE}/api/production/staff/${staff.id}`),
        fetch(`${API_BASE}/api/staff-payments/staff/${staff.id}`),
        isMonthly ? fetch(`${API_BASE}/api/salary/staff/${staff.id}/summary?days=30`) : Promise.resolve(null)
      ]);
      const prodData = await prodRes.json();
      const payData = await payRes.json();
      const salData = salRes ? await salRes.json() : null;
      setCashMemoData({
        production: prodData.status === 'ok' ? prodData.entries : [],
        payments: payData.status === 'ok' ? payData.payments : [],
        salary: salData && salData.status === 'ok' ? salData.salary : null,
        previousBalanceAdjustment: parseFloat(previousBalanceAdjustments[staff.id] || 0)
      });
    } catch (err) {
      console.error('ক্যাশ মেমো আনতে সমস্যা হয়েছে:', err);
    } finally {
      setCashMemoLoading(false);
    }
  };

  const submitProductionEntry = async () => {
    setKarigorError('');
    if (!karigorQty || parseFloat(karigorQty) <= 0) {
      setKarigorError('কত পিস তৈরি হয়েছে লিখুন');
      return;
    }
    setKarigorSubmitting(true);
    try {
      const url = editingProductionEntryId
        ? `${API_BASE}/api/production/${editingProductionEntryId}`
        : `${API_BASE}/api/production`;
      const method = editingProductionEntryId ? 'PUT' : 'POST';
      const body = editingProductionEntryId
        ? { quantity: karigorQty, product_id: karigorProduct.id, entry_date: karigorEntryDate }
        : { staff_id: karigorStaff.id, product_id: karigorProduct.id, quantity: karigorQty, entry_date: karigorEntryDate };
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setShowKarigorHisab(false);
        setKarigorStep('select-staff');
        setKarigorStaff(null);
        setKarigorProduct(null);
        setKarigorQty('');
        setEditingProductionEntryId(null);
        fetchProductionSummaryAll();
        fetchRecentProduction();
      } else {
        setKarigorError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setKarigorError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setKarigorSubmitting(false);
    }
  };

  const fetchRecentProduction = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/production/recent-all?hours=3`);
      const data = await res.json();
      if (data.status === 'ok') {
        const map = {};
        for (const entry of data.recent) map[entry.staff_id] = entry;
        setRecentProduction(map);
      }
    } catch (err) {
      console.error('সাম্প্রতিক প্রোডাকশন এন্ট্রি আনতে সমস্যা হয়েছে:', err);
    }
  };

  const openEditProductionEntry = (entry, staff) => {
    setKarigorStaff(staff);
    setKarigorProduct({ id: entry.product_id, name: entry.product_name, sewing_price: entry.sewing_price });
    setKarigorQty(String(entry.quantity));
    setKarigorEntryDate(entry.entry_date ? entry.entry_date.slice(0, 10) : '');
    setEditingProductionEntryId(entry.id);
    setShowKarigorHisab(true);
    setKarigorStep('enter-qty');
  };


  const handleAddExpense = async (e) => {
    e.preventDefault();
    setExpenseError('');
    if (!expenseForm.description.trim() || !expenseForm.amount) {
      setExpenseError('বিবরণ এবং টাকার পরিমাণ দিতে হবে');
      return;
    }
    setExpenseSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/expenses`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(expenseForm)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setExpenseForm({ description: '', amount: '', expense_date: '' });
        fetchExpenses();
      } else {
        setExpenseError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setExpenseError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setExpenseSubmitting(false);
    }
  };

  const fetchExpenses = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/expenses`);
      const data = await res.json();
      if (data.status === 'ok') setExpenses(data.expenses);
    } catch (err) {
      console.error('খরচ লিস্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const openExpenseReport = async () => {
    setShowExpenseReport(true);
    setExpenseReportLoading(true);
    try {
      const [expRes, payRes, partnerExpRes] = await Promise.all([
        fetch(`${API_BASE}/api/expenses`),
        fetch(`${API_BASE}/api/staff-payments`),
        fetch(`${API_BASE}/api/partners/expenses-all`)
      ]);
      const expData = await expRes.json();
      const payData = await payRes.json();
      const partnerExpData = await partnerExpRes.json();
      setAllExpenses(expData.status === 'ok' ? expData.expenses : []);
      setAllStaffPayments(payData.status === 'ok' ? payData.payments : []);
      setAllPartnerExpenses(partnerExpData.status === 'ok' ? partnerExpData.expenses : []);
    } catch (err) {
      console.error('খরচের বিস্তারিত আনতে সমস্যা হয়েছে:', err);
    } finally {
      setExpenseReportLoading(false);
    }
  };

  const submitWeeklyPayment = async () => {
    setWeeklyError('');
    if (!weeklyAmount || parseFloat(weeklyAmount) <= 0) {
      setWeeklyError('কত টাকা দেওয়া হয়েছে লিখুন');
      return;
    }
    setWeeklySubmitting(true);
    try {
      const url = editingPaymentId ? `${API_BASE}/api/staff-payments/${editingPaymentId}` : `${API_BASE}/api/staff-payments`;
      const method = editingPaymentId ? 'PUT' : 'POST';
      const body = editingPaymentId
        ? { amount: weeklyAmount, payment_date: weeklyPaymentDate }
        : { staff_id: weeklyStaff.id, amount: weeklyAmount, payment_date: weeklyPaymentDate };
      const res = await fetch(url, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setShowWeeklyPicker(false);
        setWeeklyStaff(null);
        setWeeklyAmount('');
        setWeeklyPaymentDate('');
        setEditingPaymentId(null);
        fetchRecentPayments();
        fetchPaymentsSummaryAll();
        fetchSalarySummaryAll();
      } else {
        setWeeklyError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setWeeklyError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setWeeklySubmitting(false);
    }
  };

  const fetchRecentPayments = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/staff-payments/recent-all?hours=3`);
      const data = await res.json();
      if (data.status === 'ok') {
        const map = {};
        for (const p of data.recent) map[p.staff_id] = p;
        setRecentPayments(map);
      }
    } catch (err) {
      console.error('সাম্প্রতিক পেমেন্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const openEditPayment = (payment, staff) => {
    setWeeklyStaff(staff);
    setWeeklyAmount(String(payment.amount));
    setWeeklyPaymentDate(payment.payment_date ? payment.payment_date.slice(0, 10) : '');
    setEditingPaymentId(payment.id);
    setShowWeeklyPicker(true);
  };

  const handleSaveDuty = async (e) => {
    e.preventDefault();
    setDutySubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/duty-schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dutyForm)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setShowDutyForm(false);
      }
    } catch (err) {
      alert('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setDutySubmitting(false);
    }
  };

  const handleAddMachine = async (e) => {
    e.preventDefault();
    setMachineError('');
    if (!machineForm.name.trim() || !machineForm.ip_address.trim()) {
      setMachineError('নাম এবং IP অ্যাড্রেস দিতে হবে');
      return;
    }
    setMachineSubmitting(true);
    try {
      const url = editingMachineId ? `${API_BASE}/api/machines/${editingMachineId}` : `${API_BASE}/api/machines`;
      const method = editingMachineId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...machineForm, port: parseInt(machineForm.port) || 4370 })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setMachineForm({ name: '', ip_address: '', port: '4370' });
        setEditingMachineId(null);
        fetchMachines();
      } else {
        setMachineError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setMachineError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setMachineSubmitting(false);
    }
  };

  const startEditMachine = (m) => {
    setEditingMachineId(m.id);
    setMachineForm({ name: m.name, ip_address: m.ip_address, port: String(m.port) });
    setMachineError('');
  };

  const cancelEditMachine = () => {
    setEditingMachineId(null);
    setMachineForm({ name: '', ip_address: '', port: '4370' });
  };

  const deleteMachine = async (id) => {
    try {
      await fetch(`${API_BASE}/api/machines/${id}`, { method: 'DELETE' });
      fetchMachines();
    } catch (err) {
      console.error('মেশিন ডিলিট করতে সমস্যা হয়েছে:', err);
    }
  };

  const deleteStaff = async (id, name) => {
    const sure = window.confirm(`${name}-কে ডিলিট করবেন? এটা আর ফেরত আনা যাবে না।`);
    if (!sure) return;
    try {
      await fetch(`${API_BASE}/api/staff/${id}`, { method: 'DELETE' });
      fetchStaff();
    } catch (err) {
      console.error('স্টাফ ডিলিট করতে সমস্যা হয়েছে:', err);
    }
  };

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('maya_token') || ''}`
  });

  const fetchUsers = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/users`, { headers: authHeaders() });
      const data = await res.json();
      if (data.status === 'ok') setUsers(data.users);
    } catch (err) {
      console.error('ইউজার লিস্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    setUserError('');
    if (editingUserId) {
      if (!userForm.name.trim() || !userForm.phone.trim()) {
        setUserError('নাম এবং ফোন নাম্বার দিতে হবে');
        return;
      }
      setUserSubmitting(true);
      try {
        const res = await fetch(`${API_BASE}/api/auth/users/${editingUserId}`, {
          method: 'PUT',
          headers: authHeaders(),
          body: JSON.stringify({ name: userForm.name, phone: userForm.phone, role: userForm.role, is_partner: userForm.is_partner })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          setEditingUserId(null);
          setUserForm({ name: '', phone: '', password: '', role: 'moderator', is_partner: false });
          fetchUsers();
        } else {
          setUserError(data.message || 'কিছু একটা ভুল হয়েছে');
        }
      } catch (err) {
        setUserError('সার্ভারের সাথে কানেক্ট করা যায়নি');
      } finally {
        setUserSubmitting(false);
      }
      return;
    }
    if (!userForm.name.trim() || !userForm.phone.trim() || !userForm.password.trim()) {
      setUserError('নাম, ফোন এবং পাসওয়ার্ড দিতে হবে');
      return;
    }
    setUserSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(userForm)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setUserForm({ name: '', phone: '', password: '', role: 'moderator', is_partner: false });
        fetchUsers();
      } else {
        setUserError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setUserError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setUserSubmitting(false);
    }
  };

  const startEditUser = (u) => {
    setEditingUserId(u.id);
    setUserForm({ name: u.name, phone: u.phone, password: '', role: u.role, is_partner: !!u.is_partner });
    setUserError('');
  };

  const cancelEditUser = () => {
    setEditingUserId(null);
    setUserForm({ name: '', phone: '', password: '', role: 'moderator', is_partner: false });
    setUserError('');
  };


  const deleteUser = async (id) => {
    if (!confirm('এই ইউজারকে ডিলিট করবেন? পরে চাইলে আবার এই ফোন নাম্বার দিয়েই নতুন করে যোগ করা যাবে।')) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/users/${id}`, { method: 'DELETE', headers: authHeaders() });
      const data = await res.json();
      if (data.status === 'ok') {
        fetchUsers();
      } else {
        alert(data.message || 'ডিলিট করতে সমস্যা হয়েছে');
      }
    } catch (err) {
      console.error('ইউজার ডিলিট করতে সমস্যা হয়েছে:', err);
      alert('সার্ভারের সাথে কানেক্ট করা যায়নি');
    }
  };

  // ==================== নিজের প্রোফাইল (নাম/ছবি/পাসওয়ার্ড) ====================

  const openEditProfile = () => {
    setProfileForm({ name: currentUser?.name || '', photo_url: currentUser?.photo_url || '', current_password: '', new_password: '' });
    setProfileError('');
    setProfileSuccess('');
    setShowProfileMenu(false);
    setShowEditProfile(true);
  };

  // ছবি ছোট করে (max 200x200) base64 বানিয়ে দেয়, যাতে ডাটাবেজে সহজে সেভ করা যায়
  const handleProfilePhotoChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSize = 200;
        let { width, height } = img;
        if (width > height) {
          if (width > maxSize) { height = Math.round(height * (maxSize / width)); width = maxSize; }
        } else {
          if (height > maxSize) { width = Math.round(width * (maxSize / height)); height = maxSize; }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL('image/jpeg', 0.8);
        setProfileForm((prev) => ({ ...prev, photo_url: compressed }));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };

  const submitProfileUpdate = async () => {
    setProfileError('');
    setProfileSuccess('');
    if (profileForm.new_password && !profileForm.current_password) {
      setProfileError('পাসওয়ার্ড বদলাতে হলে বর্তমান পাসওয়ার্ড দিতে হবে');
      return;
    }
    setProfileSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          name: profileForm.name,
          photo_url: profileForm.photo_url,
          current_password: profileForm.current_password || undefined,
          new_password: profileForm.new_password || undefined
        })
      });
      const data = await res.json();
      if (data.status === 'ok') {
        onUpdateUser({ name: data.user.name, photo_url: data.user.photo_url });
        setProfileForm((prev) => ({ ...prev, current_password: '', new_password: '' }));
        setProfileSuccess('প্রোফাইল আপডেট হয়েছে ✅');
        fetchPartners(); // পার্টনার লিস্টে নিজের নতুন নাম/ছবি সাথে সাথে দেখানোর জন্য
      } else {
        setProfileError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setProfileError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setProfileSubmitting(false);
    }
  };

  // ==================== পার্টনার হিসাব ====================

  const fetchPartners = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/partners`, { cache: 'no-store' });
      const data = await res.json();
      if (data.status === 'ok') setPartners(data.partners);
    } catch (err) {
      console.error('পার্টনার লিস্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const scrollPartnerLogToBottom = () => {
    // আসল স্ক্রল-হওয়া জায়গাটা ভেতরের বক্স নাকি পুরো উইন্ডো, সেটা নিশ্চিত না হয়ে দুটোই স্ক্রল করা হচ্ছে —
    // যেটা আসল স্ক্রলিং কনটেইনার, সেটাই কাজ করবে, অন্যটা এমনিতেই কিছু করবে না
    window.scrollTo({ top: document.body.scrollHeight });
    if (partnerLogScrollRef.current) {
      partnerLogScrollRef.current.scrollTop = partnerLogScrollRef.current.scrollHeight;
    }
  };

  // লগ খোলার পরের কিছুক্ষণ কনটেন্টের উচ্চতা বদলালেই (যেমন কোনো ছবি দেরিতে লোড হলে) আবার নিচে স্ক্রল করে
  // দেওয়া হবে — এরপর বন্ধ হয়ে যাবে, যাতে পরে কেউ উপরে স্ক্রল করে পুরনো পোস্ট পড়তে থাকলে জোর করে
  // আবার নিচে নিয়ে না যায়
  useEffect(() => {
    if (!showPartnerLogPage || !partnerLogScrollRef.current) return;
    const container = partnerLogScrollRef.current;
    const observer = new ResizeObserver(() => {
      scrollPartnerLogToBottom();
    });
    observer.observe(container);
    const stopTimer = setTimeout(() => observer.disconnect(), 2000);
    return () => {
      observer.disconnect();
      clearTimeout(stopTimer);
    };
  }, [showPartnerLogPage]);

  const openPartnerLogPage = async () => {
    setShowPartnerLogPage(true);
    fetchPartners();
    setPartnerLogLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/partners/all-transactions`);
      const data = await res.json();
      setAllPartnerTransactions(data.status === 'ok' ? data.transactions : []);
      // মেসেঞ্জার/হোয়াটসঅ্যাপের মতো — লগ খুললেই সরাসরি সবচেয়ে নতুন (নিচের) কথোপকথনে নিয়ে যাওয়া হবে।
      // প্রোফাইল ছবি ইত্যাদি একটু পর পর লোড হওয়ায় (যার ফলে উচ্চতা বদলে যায়), শুধু একবার না —
      // কয়েকবার ভিন্ন ভিন্ন সময়ে চেষ্টা করা হচ্ছে, যাতে ছবি লোড হওয়ার পরও সঠিক জায়গায় স্ক্রল হয়
      [0, 100, 300, 600, 1000].forEach((delay) => {
        setTimeout(scrollPartnerLogToBottom, delay);
      });
    } catch (err) {
      console.error('পার্টনার লগ আনতে সমস্যা হয়েছে:', err);
    } finally {
      setPartnerLogLoading(false);
    }
  };

  // ==================== ওভারটাইম ====================

  const openOvertimePage = () => {
    setShowOvertimePage(true);
    setOvertimeView('choose');
    setOvertimeSelectedStaff([]);
    setOvertimeEndResult(null);
    fetchOvertimeActive();
    fetchOvertimeLog();
  };

  const fetchOvertimeActive = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/overtime/active`);
      const data = await res.json();
      if (data.status === 'ok') setOvertimeActiveSessions(data.active);
    } catch (err) {
      console.error('চলমান ওভারটাইম আনতে সমস্যা হয়েছে:', err);
    }
  };

  const fetchOvertimeLog = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/overtime/log`);
      const data = await res.json();
      if (data.status === 'ok') setOvertimeLog(data.log);
    } catch (err) {
      console.error('ওভারটাইম লগ আনতে সমস্যা হয়েছে:', err);
    }
  };

  // ==================== পাইকার (Wholesaler) ====================

  const openWholesalerLock = (target) => {
    // পুরনো/অবশিষ্ট state থাকলে সেটা পরিষ্কার করে দেওয়া হচ্ছে, যাতে লক কখনো এড়িয়ে যাওয়া না যায়
    setShowWholesalerAccountSelectPage(false);
    setSelectedWholesalerForAccount(null);
    setShowWholesalerPage(false);
    setShowWholesalerRatePage(false);

    setWholesalerLockTarget(target || 'add');
    setShowWholesalerLockPrompt(true);
    setWholesalerPasswordInput('');
    setWholesalerPasswordError('');
  };

  const confirmWholesalerLock = () => {
    if (wholesalerPasswordInput !== 'Maya') {
      setWholesalerPasswordError('পাসওয়ার্ড ভুল');
      return;
    }
    setShowWholesalerLockPrompt(false);
    if (wholesalerLockTarget === 'account') {
      openWholesalerAccountSelect();
    } else {
      setShowWholesalerPage(true);
      fetchWholesalers();
    }
  };

  const fetchWholesalers = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/wholesalers`);
      const data = await res.json();
      if (data.status === 'ok') setWholesalers(data.wholesalers);
    } catch (err) {
      console.error('পাইকার লিস্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const openAddWholesalerForm = () => {
    setWholesalerForm({ name: '', address: '', phone: '' });
    setWholesalerError('');
    setEditingWholesalerId(null);
    setShowAddWholesalerForm(true);
  };

  const submitWholesaler = async () => {
    setWholesalerError('');
    if (!wholesalerForm.name.trim()) {
      setWholesalerError('পাইকারের নাম দিতে হবে');
      return;
    }
    setWholesalerSubmitting(true);
    try {
      const url = editingWholesalerId ? `${API_BASE}/api/wholesalers/${editingWholesalerId}` : `${API_BASE}/api/wholesalers`;
      const res = await fetch(url, {
        method: editingWholesalerId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wholesalerForm)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setShowAddWholesalerForm(false);
        setEditingWholesalerId(null);
        fetchWholesalers();
      } else {
        setWholesalerError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setWholesalerError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setWholesalerSubmitting(false);
    }
  };

  const startEditWholesaler = (w) => {
    setEditingWholesalerId(w.id);
    setWholesalerForm({ name: w.name || '', address: w.address || '', phone: w.phone || '' });
    setWholesalerError('');
    setShowAddWholesalerForm(true);
  };

  const confirmDeleteWholesaler = async (id) => {
    try {
      await fetch(`${API_BASE}/api/wholesalers/${id}`, { method: 'DELETE' });
      setDeletingWholesalerId(null);
      fetchWholesalers();
    } catch (err) {
      alert('মুছতে সমস্যা হয়েছে');
    }
  };

  const openWholesalerRatePage = () => {
    setShowWholesalerRatePage(true);
    setSelectedWholesalerForRate(null);
    setWholesalerRateForm({ product_name: '', price: '' });
    fetchWholesalers();
  };

  const selectWholesalerForRate = async (w) => {
    setSelectedWholesalerForRate(w);
    setWholesalerRateForm({ product_name: '', price: '' });
    setEditingRateId(null);
    try {
      const res = await fetch(`${API_BASE}/api/wholesalers/${w.id}/rates`);
      const data = await res.json();
      if (data.status === 'ok') setWholesalerRates(data.rates);
    } catch (err) {
      console.error('পাইকারের রেট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const startEditRate = (rate) => {
    setEditingRateId(rate.id);
    setWholesalerRateForm({ product_name: rate.product_name, price: String(rate.price) });
  };

  const cancelEditRate = () => {
    setEditingRateId(null);
    setWholesalerRateForm({ product_name: '', price: '' });
  };

  // ==================== পাইকারি হিসাব ====================

  // ==================== ম্যানুয়ালি উপস্থিতি যুক্ত করুন ====================

  const openManualAttendancePage = () => {
    setShowManualAttendancePage(true);
    fetchRecentManualAdds();
  };

  const fetchRecentManualAdds = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/attendance/manual-add/recent`);
      const data = await res.json();
      if (data.status === 'ok') setRecentManualAdds(data.staff_ids);
    } catch (err) {
      console.error('সাম্প্রতিক ম্যানুয়াল এন্ট্রি আনতে সমস্যা হয়েছে:', err);
    }
  };

  const openManualAttendanceStaff = (s) => {
    setManualAttendanceStaff(s);
    setManualSelectedDates([]);
    setManualSelectedShifts([1]);
  };

  // স্টাফের জয়েনিং তারিখ থেকে আজ পর্যন্ত সব তারিখ (সাম্প্রতিক আগে)
  const getManualDateOptions = (staff) => {
    const dates = [];
    const start = new Date(staff.joining_date);
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    for (let d = new Date(end); d >= start; d.setDate(d.getDate() - 1)) {
      dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return dates;
  };

  const toggleManualDate = (dateStr) => {
    setManualSelectedDates((prev) =>
      prev.includes(dateStr) ? prev.filter((d) => d !== dateStr) : [...prev, dateStr]
    );
  };

  const toggleManualShift = (shiftNum) => {
    setManualSelectedShifts((prev) =>
      prev.includes(shiftNum) ? prev.filter((s) => s !== shiftNum) : [...prev, shiftNum]
    );
  };

  const submitManualAttendance = async () => {
    if (manualSelectedDates.length === 0 || manualSelectedShifts.length === 0) return;
    setManualAddSubmitting(true);
    try {
      // পুরো দিন কাজ করলে দুই শিফটই সিলেক্ট থাকতে পারে — প্রতিটা শিফটের জন্য আলাদা করে যোগ করা হচ্ছে
      let totalSkippedFuture = 0;
      for (const shiftNum of manualSelectedShifts) {
        const res = await fetch(`${API_BASE}/api/attendance/manual-add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            staff_id: manualAttendanceStaff.id,
            dates: manualSelectedDates,
            shift: shiftNum
          })
        });
        const data = await res.json();
        if (data.status !== 'ok') {
          alert(data.message || 'কিছু একটা ভুল হয়েছে');
          setManualAddSubmitting(false);
          return;
        }
        totalSkippedFuture += data.skipped_future || 0;
      }
      setManualAttendanceStaff(null);
      fetchRecentManualAdds();
      fetchAttendanceToday();
      if (totalSkippedFuture > 0) {
        alert(`${totalSkippedFuture} টা এন্ট্রি যোগ করা হয়নি — কারণ সেই শিফট এখনো শুরুই হয়নি (ভবিষ্যতের সময়ে উপস্থিত মার্ক করা যায় না)।`);
      }
    } catch (err) {
      alert('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setManualAddSubmitting(false);
    }
  };

  const openWholesalerAccountSelect = () => {
    setShowWholesalerAccountSelectPage(true);
    fetchWholesalers();
  };

  const fetchWholesalerAccountData = async (wid) => {
    try {
      const [ledgerRes, summaryRes, ratesRes] = await Promise.all([
        fetch(`${API_BASE}/api/wholesalers/${wid}/ledger`),
        fetch(`${API_BASE}/api/wholesalers/${wid}/summary`),
        fetch(`${API_BASE}/api/wholesalers/${wid}/rates`)
      ]);
      const ledgerData = await ledgerRes.json();
      const summaryData = await summaryRes.json();
      const ratesData = await ratesRes.json();
      if (ledgerData.status === 'ok') setWholesalerLedger(ledgerData.ledger);
      if (summaryData.status === 'ok') setWholesalerAccountSummary(summaryData.summary);
      if (ratesData.status === 'ok') setWholesalerAccountProducts(ratesData.rates);
    } catch (err) {
      console.error('পাইকারের হিসাব আনতে সমস্যা হয়েছে:', err);
    }
  };

  const openWholesalerAccount = (w) => {
    setSelectedWholesalerForAccount(w);
    fetchWholesalerAccountData(w.id);
  };

  const openLedgerForm = (type) => {
    setLedgerForm({ type, product_name: '', quantity: '', editingId: null });
    setLedgerFormError('');
  };

  const startEditLedgerEntry = (entry) => {
    setLedgerForm({
      type: entry.entry_type,
      product_name: entry.product_name,
      quantity: String(entry.quantity),
      editingId: entry.id
    });
    setLedgerFormError('');
  };

  const submitLedgerForm = async () => {
    setLedgerFormError('');
    if (!ledgerForm.product_name || !ledgerForm.quantity || parseFloat(ledgerForm.quantity) <= 0) {
      setLedgerFormError('প্রোডাক্ট এবং পিস সংখ্যা দিতে হবে');
      return;
    }
    setLedgerSubmitting(true);
    try {
      let res;
      if (ledgerForm.editingId) {
        res = await fetch(`${API_BASE}/api/wholesalers/ledger/${ledgerForm.editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quantity: ledgerForm.quantity })
        });
      } else {
        const endpoint = ledgerForm.type === 'add' ? 'add' : 'return';
        res = await fetch(`${API_BASE}/api/wholesalers/${selectedWholesalerForAccount.id}/ledger/${endpoint}`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ product_name: ledgerForm.product_name, quantity: ledgerForm.quantity })
        });
      }
      const data = await res.json();
      if (data.status === 'ok') {
        setLedgerForm(null);
        fetchWholesalerAccountData(selectedWholesalerForAccount.id);
      } else {
        setLedgerFormError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setLedgerFormError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setLedgerSubmitting(false);
    }
  };

  // পুরো পাইকারের হিসাব (সব পাতা, সবগুলো এন্ট্রি) একটা PDF বানিয়ে শেয়ার করার জন্য
  // কুরিয়ার স্টিকার — একটা নতুন উইন্ডো খুলে সেখানে সরাসরি ৩x৩ ইঞ্চি প্রিন্ট-রেডি HTML রেন্ডার করে
  // ব্রাউজারের নিজস্ব প্রিন্ট ইঞ্জিন (window.print()) ট্রিগার করা হচ্ছে — html2canvas/jsPDF দিয়ে
  // ক্যাপচার-ভিত্তিক পদ্ধতির বদলে এটা অনেক বেশি নির্ভরযোগ্য (কোনো ক্যানভাস-সাইজ/উপচে পড়ার ঝুঁকি নেই)
  const printCourierSticker = () => {
    const entry = courierSuccessResult?.entry;
    if (!entry) return;

    const pageName = entry.page_name || 'Maya Garments';
    const orderNumber = entry.order_number ?? entry.id;
    const image = entry.image_urls && entry.image_urls[0] ? entry.image_urls[0] : null;

    const escapeHtml = (s) =>
      String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Courier Pad</title>
<style>
  @page { size: 3in 3in; margin: 0; }
  * { box-sizing: border-box; }
  html, body {
    width: 3in; height: 3in; margin: 0; padding: 0;
    font-family: 'Times New Roman', Times, Georgia, serif;
    color: #111;
    -webkit-print-color-adjust: exact;
  }
  .pad {
    width: 3in; height: 3in; padding: 0.17in; display: flex; flex-direction: column;
    border: 3px double #111;
  }
  .header { text-align: center; }
  .page-name { font-size: 15pt; font-weight: 700; letter-spacing: 0.5px; }
  hr { border: none; border-top: 1.4px solid #111; margin: 5px 0; width: 100%; }
  .parcel-label { text-align: center; font-size: 7pt; letter-spacing: 1.5px; color: #555; }
  .parcel-id { text-align: center; font-size: 21pt; font-weight: 700; line-height: 1.15; word-break: break-all; }
  .body-row { display: flex; flex: 1; gap: 0.1in; min-height: 0; }
  .photo-col { width: 38%; display: flex; align-items: center; justify-content: center; }
  .photo-col img { width: 100%; height: 100%; object-fit: cover; border: 1px solid #999; }
  .photo-col .no-photo {
    width: 100%; height: 100%; border: 1px dashed #aaa; display: flex;
    align-items: center; justify-content: center; font-size: 7pt; color: #999; text-align: center;
  }
  .info-col { width: 62%; display: flex; flex-direction: column; justify-content: center; }
  .order-num { font-size: 15pt; font-weight: 700; margin-bottom: 4px; }
  .info-line { font-size: 9pt; margin: 1.5px 0; line-height: 1.3; }
  .info-line .label { color: #555; font-size: 7.5pt; }
  .bill { font-size: 11pt; font-weight: 700; margin-top: 3px; }
</style>
</head>
<body>
  <div class="pad">
    <div class="header">
      <div class="page-name">${escapeHtml(pageName)}</div>
    </div>
    <hr />
    <div class="parcel-label">PARCEL ID</div>
    <div class="parcel-id">${escapeHtml(courierSuccessResult.consignment_id || '—')}</div>
    <hr />
    <div class="body-row">
      <div class="photo-col">
        ${image ? `<img src="${escapeHtml(image)}" />` : `<div class="no-photo">No Photo</div>`}
      </div>
      <div class="info-col">
        <div class="order-num">Order #${escapeHtml(orderNumber)}</div>
        <div class="info-line"><span class="label">Phone:</span> ${escapeHtml(entry.customer_phone || '—')}</div>
        <div class="bill">৳${escapeHtml(entry.amount || 0)}</div>
      </div>
    </div>
  </div>
  <script>
    ${image ? `
      var img = document.querySelector('img');
      var done = false;
      function go() { if (!done) { done = true; window.print(); } }
      img.addEventListener('load', go);
      img.addEventListener('error', go);
      setTimeout(go, 1500);
    ` : `window.print();`}
  </script>
</body>
</html>`;

    const win = window.open('', '_blank', 'width=400,height=500');
    if (!win) {
      alert('পপআপ ব্লক হয়ে গেছে — ব্রাউজারে এই সাইটের জন্য পপআপ অনুমতি দিন');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  };

  const shareWholesalerFullAccount = async () => {
    setSharingPDF(true);
    try {
      await generateServerPDF(
        'wholesaler-account-content',
        `হিসাব-${selectedWholesalerForAccount?.name || 'পাইকার'}`,
        'পাইকারি হিসাব',
        authHeaders()
      );
    } catch (err) {
      alert(err.message || 'PDF তৈরি করতে সমস্যা হয়েছে');
    } finally {
      setSharingPDF(false);
    }
  };

  const deleteLedgerEntry = async (id) => {
    if (!window.confirm('এই এন্ট্রি মুছে ফেলতে চান? এটা ফেরত আনা যাবে না।')) return;
    try {
      await fetch(`${API_BASE}/api/wholesalers/ledger/${id}`, { method: 'DELETE' });
      fetchWholesalerAccountData(selectedWholesalerForAccount.id);
    } catch (err) {
      console.error('এন্ট্রি মুছতে সমস্যা হয়েছে:', err);
    }
  };

  const openPaymentForm = () => {
    setPaymentForm({ description: '', amount: '', editingId: null });
    setPaymentFormError('');
  };

  const startEditPayment = (entry) => {
    setPaymentForm({ description: entry.description, amount: String(entry.amount), editingId: entry.id });
    setPaymentFormError('');
  };

  const submitPaymentForm = async () => {
    setPaymentFormError('');
    if (!paymentForm.description.trim() || !paymentForm.amount || parseFloat(paymentForm.amount) <= 0) {
      setPaymentFormError('বিবরণ এবং টাকার পরিমাণ দিতে হবে');
      return;
    }
    setPaymentSubmitting(true);
    try {
      let res;
      if (paymentForm.editingId) {
        res = await fetch(`${API_BASE}/api/wholesalers/ledger/${paymentForm.editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: paymentForm.description, amount: paymentForm.amount })
        });
      } else {
        res = await fetch(`${API_BASE}/api/wholesalers/${selectedWholesalerForAccount.id}/ledger/payment`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ description: paymentForm.description, amount: paymentForm.amount })
        });
      }
      const data = await res.json();
      if (data.status === 'ok') {
        setPaymentForm(null);
        fetchWholesalerAccountData(selectedWholesalerForAccount.id);
      } else {
        setPaymentFormError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setPaymentFormError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setPaymentSubmitting(false);
    }
  };

  const submitWholesalerRate = async () => {
    if (!wholesalerRateForm.product_name.trim() || !wholesalerRateForm.price) return;
    setWholesalerRateSubmitting(true);
    try {
      const url = editingRateId
        ? `${API_BASE}/api/wholesalers/rates/${editingRateId}`
        : `${API_BASE}/api/wholesalers/${selectedWholesalerForRate.id}/rates`;
      const method = editingRateId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wholesalerRateForm)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setWholesalerRateForm({ product_name: '', price: '' });
        setEditingRateId(null);
        selectWholesalerForRate(selectedWholesalerForRate);
      }
    } catch (err) {
      console.error('রেট যোগ করতে সমস্যা হয়েছে:', err);
    } finally {
      setWholesalerRateSubmitting(false);
    }
  };

  const toggleOvertimeStaff = (staffId) => {
    setOvertimeSelectedStaff((prev) =>
      prev.includes(staffId) ? prev.filter((id) => id !== staffId) : [...prev, staffId]
    );
  };

  const submitOvertimeStart = async () => {
    if (overtimeSelectedStaff.length === 0) return;
    setOvertimeStarting(true);
    try {
      await fetch(`${API_BASE}/api/overtime/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staff_ids: overtimeSelectedStaff })
      });
      setOvertimeSelectedStaff([]);
      setOvertimeView('choose');
      fetchOvertimeActive();
    } catch (err) {
      console.error('ওভারটাইম শুরু করতে সমস্যা হয়েছে:', err);
    } finally {
      setOvertimeStarting(false);
    }
  };

  const confirmOvertimeEnd = async () => {
    setOvertimeEnding(true);
    try {
      const res = await fetch(`${API_BASE}/api/overtime/end`, { method: 'POST' });
      const data = await res.json();
      if (data.status === 'ok') {
        setOvertimeEndResult(data.ended);
        setShowOvertimeEndConfirm(false);
        fetchOvertimeActive();
        fetchOvertimeLog();
      }
    } catch (err) {
      console.error('ওভারটাইম শেষ করতে সমস্যা হয়েছে:', err);
    } finally {
      setOvertimeEnding(false);
    }
  };

  const fetchAllPartnerTransactions = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/partners/all-transactions`);
      const data = await res.json();
      setAllPartnerTransactions(data.status === 'ok' ? data.transactions : []);
    } catch (err) {
      console.error('পার্টনার লগ আনতে সমস্যা হয়েছে:', err);
    }
  };

  const openPartnerDetail = async (partner) => {
    setSelectedPartner(partner);
    setPartnerDetailLoading(true);
    // যৌথ "পার্টনার হিসাব" পেজ থেকে এখানে আসার সময় সেই পেজের স্ক্রল-পজিশন (নিচে) যেন এই পেজে
    // থেকে না যায় — এই পার্সোনাল লগে নতুন এন্ট্রি উপরে যোগ হয়, তাই এখানে সবসময় উপর থেকেই শুরু হওয়া উচিত
    window.scrollTo({ top: 0 });
    // যৌথ লগ পেজের অবস্থা এখানে সরাসরি বন্ধ করা হচ্ছে না — তাহলে ব্যাক বাটনের ধাপ (personal → যৌথ লগ →
    // হোম) ভেঙে যায়। শুধু স্ক্রল রিসেট করাই যথেষ্ট।
    try {
      const [txnRes, sumRes] = await Promise.all([
        fetch(`${API_BASE}/api/partners/${partner.id}/transactions`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/partners/${partner.id}/summary`)
      ]);
      const txnData = await txnRes.json();
      const sumData = await sumRes.json();
      setPartnerTransactions(txnData.status === 'ok' ? txnData.transactions : []);
      setPartnerSummary(sumData.status === 'ok' ? sumData.summary : null);
    } catch (err) {
      console.error('পার্টনারের হিসাব আনতে সমস্যা হয়েছে:', err);
    } finally {
      setPartnerDetailLoading(false);
    }
  };

  const openAddPartnerTxn = (type) => {
    setPartnerTxnForm({ type, editingId: null, description: '', amount: '', image_url: '' });
    setPartnerTxnError('');
  };

  const openEditPartnerTxn = (txn) => {
    setPartnerTxnForm({ type: txn.type, editingId: txn.id, description: txn.description, amount: String(txn.amount), image_url: txn.image_url || '' });
    setPartnerTxnError('');
  };

  // ছবি ছোট করে (max 500px চওড়া) base64 বানায়, যাতে সহজে সেভ করা যায়
  const handlePartnerTxnImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSize = 1400;
        let { width, height } = img;
        if (width > height) {
          if (width > maxSize) { height = Math.round(height * (maxSize / width)); width = maxSize; }
        } else {
          if (height > maxSize) { width = Math.round(width * (maxSize / height)); height = maxSize; }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL('image/jpeg', 0.9);
        setPartnerTxnForm((prev) => ({ ...prev, image_url: compressed }));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };

  const submitPartnerTxn = async () => {
    setPartnerTxnError('');
    if (!partnerTxnForm.description.trim() || !partnerTxnForm.amount || parseFloat(partnerTxnForm.amount) <= 0) {
      setPartnerTxnError('বিবরণ এবং টাকার পরিমাণ দিতে হবে');
      return;
    }
    setPartnerTxnSubmitting(true);
    try {
      const url = partnerTxnForm.editingId
        ? `${API_BASE}/api/partners/transactions/${partnerTxnForm.editingId}`
        : `${API_BASE}/api/partners/transactions`;
      const method = partnerTxnForm.editingId ? 'PUT' : 'POST';
      const body = partnerTxnForm.editingId
        ? { description: partnerTxnForm.description, amount: partnerTxnForm.amount, image_url: partnerTxnForm.image_url || null }
        : { type: partnerTxnForm.type, description: partnerTxnForm.description, amount: partnerTxnForm.amount, image_url: partnerTxnForm.image_url || null };
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(body) });
      const data = await res.json();
      if (data.status === 'ok') {
        setPartnerTxnForm(null);
        if (data.pending) {
          alert('এডিট অনুরোধ পাঠানো হয়েছে ✅ — অন্য পার্টনারের অনুমোদনের পর পোস্টে পরিবর্তন দেখা যাবে।');
        }
        if (selectedPartner) openPartnerDetail(selectedPartner);
        fetchAllPartnerTransactions();
      } else {
        setPartnerTxnError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setPartnerTxnError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setPartnerTxnSubmitting(false);
    }
  };

  // পোস্টে চেপে ধরে রাখলে (long press) রিয়েক্ট পিকার খোলে
  const startLongPress = (txnId) => {
    longPressTimer.current = setTimeout(() => setReactingTxnId(txnId), 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  const removeMyReactionFromViewer = async (txnId) => {
    try {
      await fetch(`${API_BASE}/api/partners/transactions/${txnId}/react`, { method: 'DELETE', headers: authHeaders() });
      setViewingReactorsTxn(null);
      fetchAllPartnerTransactions();
      if (selectedPartner) openPartnerDetail(selectedPartner);
    } catch (err) {
      console.error('রিয়েক্ট সরাতে সমস্যা হয়েছে:', err);
    }
  };

  const submitReaction = async (txnId, reactionType, alreadyMine) => {
    setReactingTxnId(null);
    try {
      if (alreadyMine === reactionType) {
        await fetch(`${API_BASE}/api/partners/transactions/${txnId}/react`, { method: 'DELETE', headers: authHeaders() });
      } else {
        await fetch(`${API_BASE}/api/partners/transactions/${txnId}/react`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ reaction_type: reactionType })
        });
      }
      fetchAllPartnerTransactions();
      if (selectedPartner) openPartnerDetail(selectedPartner);
    } catch (err) {
      console.error('রিয়েক্ট দিতে সমস্যা হয়েছে:', err);
    }
  };

  // ==================== নোটিফিকেশন ====================

  const fetchUnreadCount = async () => {
    if (!currentUser?.is_partner) return;
    try {
      const res = await fetch(`${API_BASE}/api/notifications/unread-count`, { headers: authHeaders() });
      const data = await res.json();
      if (data.status === 'ok') setUnreadCount(data.count);
    } catch (err) {
      console.error('নোটিফিকেশন কাউন্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const openNotifications = async () => {
    if (!currentUser?.is_partner) return;
    setShowNotifications(true);
    fetchNotificationsList();
  };

  const fetchNotificationsList = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/notifications`, { headers: authHeaders() });
      const data = await res.json();
      if (data.status === 'ok') setNotifications(data.notifications);
    } catch (err) {
      console.error('নোটিফিকেশন আনতে সমস্যা হয়েছে:', err);
    }
  };

  const toggleNotificationHistory = async () => {
    const next = !showNotificationHistory;
    setShowNotificationHistory(next);
    if (next) {
      setHistoryLoading(true);
      try {
        const res = await fetch(`${API_BASE}/api/notifications/history`, { headers: authHeaders() });
        const data = await res.json();
        if (data.status === 'ok') setNotificationHistory(data.notifications);
      } catch (err) {
        console.error('নোটিফিকেশন হিস্ট্রি আনতে সমস্যা হয়েছে:', err);
      } finally {
        setHistoryLoading(false);
      }
    }
  };

  const markNotificationRead = async (id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    try {
      await fetch(`${API_BASE}/api/notifications/${id}/read`, { method: 'POST', headers: authHeaders() });
      fetchUnreadCount();
    } catch (err) {
      console.error('নোটিফিকেশন রিড করতে সমস্যা হয়েছে:', err);
    }
  };

  const respondToEditRequest = async (editRequestId, notificationId, action) => {
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
    try {
      await fetch(`${API_BASE}/api/partners/edit-requests/${editRequestId}/${action}`, {
        method: 'POST',
        headers: authHeaders()
      });
      fetchUnreadCount();
      fetchAllPartnerTransactions();
      if (selectedPartner) openPartnerDetail(selectedPartner);
    } catch (err) {
      console.error('এডিট রিকোয়েস্টে সাড়া দিতে সমস্যা হয়েছে:', err);
    }
  };

  const respondToOrderEditRequest = async (requestId, notificationId, action) => {
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
    try {
      await fetch(`${API_BASE}/api/order-entries/pending-edits/${requestId}/${action}`, {
        method: 'POST',
        headers: authHeaders()
      });
      fetchUnreadCount();
      if (showOrderApprovalsPage) fetchOrderApprovals();
    } catch (err) {
      console.error('অর্ডার এডিট রিকোয়েস্টে সাড়া দিতে সমস্যা হয়েছে:', err);
    }
  };

  const respondToOrderDeleteRequest = async (requestId, notificationId, action) => {
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
    try {
      await fetch(`${API_BASE}/api/order-entries/pending-deletes/${requestId}/${action}`, {
        method: 'POST',
        headers: authHeaders()
      });
      fetchUnreadCount();
      if (showOrderApprovalsPage) fetchOrderApprovals();
      refreshOrderList();
    } catch (err) {
      console.error('অর্ডার ডিলিট রিকোয়েস্টে সাড়া দিতে সমস্যা হয়েছে:', err);
    }
  };

  const fetchProducts = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/products`);
      const data = await res.json();
      if (data.status === 'ok') setProducts(data.products);
    } catch (err) {
      console.error('প্রোডাক্ট লিস্ট আনতে সমস্যা হয়েছে:', err);
    }
  };

  const handleAddProduct = async (e) => {
    e.preventDefault();
    setProductError('');
    if (!productForm.name.trim()) {
      setProductError('প্রোডাক্টের নাম দিতে হবে');
      return;
    }
    setProductSubmitting(true);
    try {
      const url = editingProductId ? `${API_BASE}/api/products/${editingProductId}` : `${API_BASE}/api/products`;
      const method = editingProductId ? 'PUT' : 'POST';
      const body = { name: productForm.name, sewing_price: parseFloat(productForm.sewing_price) || 0 };
      if (editingProductId) body.apply_to_existing = applyPriceToExisting;
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setProductForm({ name: '', sewing_price: '' });
        setEditingProductId(null);
        setApplyPriceToExisting(false);
        fetchProducts();
      } else {
        setProductError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setProductError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setProductSubmitting(false);
    }
  };

  const startEditProduct = (p) => {
    setEditingProductId(p.id);
    setProductForm({ name: p.name, sewing_price: String(p.sewing_price) });
    setApplyPriceToExisting(false);
    setProductError('');
  };

  const cancelEditProduct = () => {
    setEditingProductId(null);
    setProductForm({ name: '', sewing_price: '' });
    setApplyPriceToExisting(false);
  };

  const deleteProduct = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/api/products/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.status === 'ok') {
        fetchProducts();
      } else {
        alert(data.message || 'ডিলিট করা যায়নি');
      }
    } catch (err) {
      alert('সার্ভারের সাথে কানেক্ট করা যায়নি');
    }
  };

  const handleAddStaff = async (e) => {
    e.preventDefault();
    setFormError('');
    if (!form.name.trim()) {
      setFormError('নাম দিতে হবে');
      return;
    }
    setSubmitting(true);
    try {
      const url = editingStaffId ? `${API_BASE}/api/staff/${editingStaffId}` : `${API_BASE}/api/staff`;
      const method = editingStaffId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await res.json();
      if (data.status === 'ok') {
        setShowAddForm(false);
        setForm({ name: '', phone: '', designation: '', joining_date: '', rate_type: 'piece', rate_amount: '', machine_user_id: '' });
        setEditingStaffId(null);
        fetchStaff();
      } else {
        setFormError(data.message || 'কিছু একটা ভুল হয়েছে');
      }
    } catch (err) {
      setFormError('সার্ভারের সাথে কানেক্ট করা যায়নি');
    } finally {
      setSubmitting(false);
    }
  };

  const startEditStaff = (s) => {
    setForm({
      name: s.name || '',
      phone: s.phone || '',
      designation: s.designation || '',
      joining_date: s.joining_date ? s.joining_date.slice(0, 10) : '',
      rate_type: s.rate_type || 'piece',
      rate_amount: s.rate_amount ? String(s.rate_amount) : '',
      machine_user_id: s.machine_user_id || ''
    });
    setEditingStaffId(s.id);
    setFormError('');
    setShowAddForm(true);
  };

  // এখন কি ডিউটির বাইরের সময় (শুরুর আগে/লাঞ্চে/শেষের পরে) — "আজকের উপস্থিতি" পেজের সাথে সংখ্যা মেলানোর জন্য
  const isCurrentlyOffTime = (() => {
    const buildTodayTime = (hm) => {
      const [h, m] = (hm || '00:00').split(':').map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d;
    };
    const now = new Date();
    const shift1StartTime = buildTodayTime(dutyForm.shift1_start);
    const shift1EndTime = buildTodayTime(dutyForm.shift1_end);
    const shift2StartTime = buildTodayTime(dutyForm.shift2_start);
    const shift2EndTime = buildTodayTime(dutyForm.shift2_end);
    return now < shift1StartTime || (now >= shift1EndTime && now < shift2StartTime) || now >= shift2EndTime;
  })();

  const presentCount = isCurrentlyOffTime ? 0 : attendanceToday.filter((s) => s.status === 'present').length;
  const absentCount = isCurrentlyOffTime ? 0 : attendanceToday.filter((s) => s.status === 'not_marked' || s.status === 'absent').length;

  const stats = [
    { icon: <User size={22} className="text-[#075B68]" />, bg: 'bg-[#075B68]/10', dot: 'bg-[#075B68]', value: `${staffList.length}`, label: 'মোট এমপ্লয়ি', onClick: () => setShowEmployeeModal(true) },
    { icon: <CheckCircle2 size={22} className="text-[#15966F]" />, bg: 'bg-[#15966F]/10', dot: 'bg-[#15966F]', value: `${presentCount}`, label: 'মোট উপস্থিত', onClick: openAttendanceModal },
    { icon: <MapPin size={22} className="text-[#F2A900]" />, bg: 'bg-[#F2A900]/10', dot: 'bg-[#F2A900]', value: `${absentCount}`, label: 'মোট অনুপস্থিত', onClick: openAbsentModal },
  ];

  const quickActions = [
    { icon: <RefreshCw size={24} className="text-[#075B68]" />, bg: 'bg-[#075B68]/10', label: 'পার্টনার হিসাব', onClick: openPartnerLogPage },
    { icon: <CreditCard size={24} className="text-[#0A6B78]" />, bg: 'bg-[#0A6B78]/10', label: 'স্টাফ বিল', onClick: () => { setShowWeeklyPicker(true); setEditingPaymentId(null); setWeeklyStaff(null); setWeeklyAmount(''); fetchRecentPayments(); } },
    { icon: <Users size={24} className="text-[#2587A5]" />, bg: 'bg-[#2587A5]/10', label: 'কারিগর হিসাব', onClick: () => { setShowKarigorHisab(true); setKarigorStep('select-staff'); setEditingProductionEntryId(null); setKarigorProduct(null); setKarigorQty(''); fetchProducts(); fetchRecentProduction(); } },
    { icon: <Lock size={24} className="text-[#034B58]" />, bg: 'bg-[#034B58]/10', label: 'পাইকারি হিসাব', onClick: () => openWholesalerLock('account') },
    { icon: <PlusCircle size={24} className="text-[#15966F]" />, bg: 'bg-[#15966F]/10', label: 'নতুন প্রোডাক্ট যোগ করুন', onClick: () => { setShowProductForm(true); fetchProducts(); } },
    { icon: <CheckCircle2 size={24} className="text-[#0A6B78]" />, bg: 'bg-[#0A6B78]/10', label: 'খরচের বিস্তারিত', onClick: openExpenseReport },
    { icon: <HardHat size={24} className="text-[#075B68]" />, bg: 'bg-[#075B68]/10', label: 'স্টাফ যোগ করুন', onClick: () => { setEditingStaffId(null); setForm({ name: '', phone: '', designation: '', joining_date: '', rate_type: 'piece', rate_amount: '', machine_user_id: '' }); setShowAddForm(true); } },
    { icon: <Clock size={24} className="text-[#2587A5]" />, bg: 'bg-[#2587A5]/10', label: 'ডিউটি টাইম যুক্ত করুন', onClick: () => { setShowDutyForm(true); fetchDutySchedule(); } },
    { icon: <Clock size={24} className="text-[#0A6B78]" />, bg: 'bg-[#0A6B78]/10', label: 'ওভারটাইম', onClick: openOvertimePage },
    { icon: <Lock size={24} className="text-[#034B58]" />, bg: 'bg-[#034B58]/10', label: 'পাইকার যুক্ত করুন', onClick: () => openWholesalerLock('add') },
    { icon: <LogIn size={24} className="text-[#15966F]" />, bg: 'bg-[#15966F]/10', label: 'ম্যানুয়ালি উপস্থিত যুক্ত করুন', onClick: openManualAttendancePage },
    { icon: <FileText size={24} className="text-[#075B68]" />, bg: 'bg-[#075B68]/10', label: 'সেল সামারি', onClick: openSaleSummaryPage },
  ];

  const navItems = [
    { icon: <Home size={24} />, label: 'হোম', active: true },
    { icon: <Package size={24} />, label: 'প্রোডাকশন', active: false },
    { icon: <Bell size={24} />, label: 'অ্যালার্ট', active: false },
    { icon: <User size={24} />, label: 'প্রোফাইল', active: false },
  ];

  // অ্যাপ চালু হওয়ার সময় সার্ভার জেগে আছে কিনা যাচাই হচ্ছে — সবকিছুর চেয়ে বেশি অগ্রাধিকার,
  // যাতে সার্ভার ঘুম থেকে না জাগা পর্যন্ত ভুলভাবে "০"/ফাঁকা ডেটা দেখানো না হয়
  if (appWarmingUp) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen flex flex-col items-center justify-center gap-4">
          <Loader2 size={36} className="animate-spin text-[#034B58]" />
          <p className="text-sm text-gray-500">লোড হচ্ছে, একটু অপেক্ষা করুন...</p>
        </div>
      </div>
    );
  }

  // সার্ভারের সাথে একদমই সংযোগ করা যায়নি (কয়েকবার চেষ্টার পরও) — পুনরায় চেষ্টার সুযোগ দেওয়া হচ্ছে
  if (appConnectFailed) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen flex flex-col items-center justify-center gap-4 px-8 text-center">
          <Server size={36} className="text-red-400" />
          <p className="text-sm font-semibold text-gray-700">সার্ভারের সাথে সংযোগ করা যাচ্ছে না</p>
          <p className="text-xs text-gray-500">ইন্টারনেট সংযোগ চেক করুন, অথবা সার্ভার এই মুহূর্তে বন্ধ থাকতে পারে</p>
          <button
            onClick={warmUpAndLoad}
            className="bg-[#075B68] text-white rounded-full px-6 py-2.5 text-sm font-semibold active:bg-[#034B58] flex items-center gap-2"
          >
            <RefreshCw size={16} /> আবার চেষ্টা করুন
          </button>
        </div>
      </div>
    );
  }

  // ক্যাশ মেমো — সর্বোচ্চ অগ্রাধিকার, যাতে যেকোনো জায়গা থেকে খোলা হলেও প্রিন্ট সবসময় ঠিকভাবে কাজ করে
  if (cashMemoStaff) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center print:bg-white">
        <div id="dashboard-cash-memo" className="w-full sm:max-w-sm bg-white min-h-screen p-6">
          <div className="flex items-center justify-between mb-4 print:hidden">
            <button onClick={() => window.history.back()} className="text-gray-400">
              <ChevronRight size={22} className="rotate-180" />
            </button>
            <h2 className="text-lg font-bold text-gray-900">ক্যাশ মেমো</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  shareStructuredPDF(
                    buildCashMemoPDFConfig(cashMemoStaff, cashMemoData),
                    `cash-memo-${cashMemoStaff?.name || 'staff'}`,
                    'ক্যাশ মেমো',
                    'dashboard-cash-memo',
                    { onStart: () => setSharingPDF(true), onFinish: () => setSharingPDF(false), headers: authHeaders() }
                  )
                }
                disabled={sharingPDF}
                className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center active:scale-90 active:bg-emerald-200 transition-transform disabled:opacity-60"
              >
                {sharingPDF ? <Loader2 size={16} className="text-emerald-700 animate-spin" /> : <Share2 size={16} className="text-emerald-700" />}
              </button>
              <button
                onClick={() => window.print()}
                className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center active:scale-90 active:bg-red-200 transition-transform"
              >
                <Printer size={16} className="text-red-800" />
              </button>
            </div>
          </div>

          {/* মেমো হেডার */}
          <div className="text-center border-b-2 border-dashed border-gray-300 pb-4 mb-4">
            <h1 className="text-xl font-extrabold text-[#075B68] tracking-wide">Maya Garments</h1>
            <p className="text-xs text-gray-500 mt-1">চেয়ারম্যান বাড়ির মোড়, কামরাঙ্গীরচর, ঢাকা-১২১১</p>
            <p className="text-xs text-gray-500">যোগাযোগঃ 01783203215, 01762037641</p>
            <p className="text-xs text-gray-500 mt-2">কারিগর হিসাব — ক্যাশ মেমো</p>
            <p className="text-xs text-gray-400 mt-1">তারিখ: {new Date().toLocaleDateString('bn-BD')}</p>
          </div>

          <div className="mb-4">
            <p className="font-semibold text-gray-900">{cashMemoStaff.name}</p>
            <p className="text-xs text-gray-500">{cashMemoStaff.designation || 'পদবি নেই'} {cashMemoStaff.phone ? `· ${cashMemoStaff.phone}` : ''}</p>
          </div>

          {cashMemoLoading ? (
            <div className="flex justify-center py-10 print:hidden">
              <Loader2 size={28} className="animate-spin text-[#034B58]" />
            </div>
          ) : cashMemoData ? (
            <>
              {cashMemoStaff.rate_type === 'monthly' && cashMemoData.salary && (
                <div className="mb-4">
                  <div className="bg-amber-50 rounded-2xl p-4 flex items-center justify-between mb-3">
                    <span className="text-sm text-gray-600">মাসিক বেতন</span>
                    <span className="text-lg font-bold text-[#075B68]">৳ {cashMemoStaff.rate_amount}</span>
                  </div>
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">দিন-ভিত্তিক হিসাব (দৈনিক রেট ৳{cashMemoData.salary.daily_rate})</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5">অবস্থা</td>
                        <td className="py-1.5 text-right">লেট (মিনিট)</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {cashMemoData.salary.breakdown.map((d, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="py-1.5">{d.date}</td>
                          <td className="py-1.5">
                            {d.status === 'present' && 'উপস্থিত'}
                            {d.status === 'absent' && 'অনুপস্থিত'}
                            {d.status === 'holiday' && 'শুক্রবার (ছুটি)'}
                          </td>
                          <td className="py-1.5 text-right">{d.late_minutes || '—'}</td>
                          <td className="py-1.5 text-right">৳{d.day_earned}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {cashMemoStaff.rate_type === 'monthly' && cashMemoData.salary?.overtime?.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">ওভারটাইম</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5 text-right">ঘণ্টা</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {cashMemoData.salary.overtime.map((o, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="py-1.5">{o.date}</td>
                          <td className="py-1.5 text-right">{o.hours}</td>
                          <td className="py-1.5 text-right">৳{o.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex justify-between text-sm mt-2 pt-2 border-t border-gray-200">
                    <span className="text-gray-600">মোট ওভারটাইম</span>
                    <span className="font-semibold text-gray-900">৳ {cashMemoData.salary.total_overtime_amount}</span>
                  </div>
                </div>
              )}

              {cashMemoStaff.rate_type !== 'monthly' && cashMemoData.production.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">প্রোডাকশন এন্ট্রি</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5">প্রোডাক্ট</td>
                        <td className="py-1.5 text-right">পিস</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {cashMemoData.production.map((p) => (
                        <tr key={p.id} className="border-b border-gray-100">
                          <td className="py-1.5">{p.entry_date?.slice(0, 10)}</td>
                          <td className="py-1.5">{p.product_name}</td>
                          <td className="py-1.5 text-right">{p.quantity}</td>
                          <td className="py-1.5 text-right">৳{p.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {cashMemoData.payments.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">টাকা নেওয়ার হিস্ট্রি</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {cashMemoData.payments.map((pay) => (
                        <tr key={pay.id} className="border-b border-gray-100">
                          <td className="py-1.5">
                            {pay.payment_date?.slice(0, 10)}
                            {pay.edited_by_name && <span className="block text-[10px] text-amber-600">সম্পাদনা: {pay.edited_by_name}</span>}
                          </td>
                          <td className="py-1.5 text-right">৳{pay.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* টোটাল */}
              <div className="border-t-2 border-dashed border-gray-300 pt-4 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">মোট আয়</span>
                  <span className="font-semibold text-gray-900">
                    ৳ {(cashMemoStaff.rate_type === 'monthly'
                      ? (cashMemoData.salary ? cashMemoData.salary.total_salary_earned : parseFloat(cashMemoStaff.rate_amount || 0))
                      : cashMemoData.production.reduce((s, p) => s + parseFloat(p.amount), 0)
                    ).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">মোট নিয়েছে</span>
                  <span className="font-semibold text-gray-900">
                    ৳ {cashMemoData.payments.reduce((s, p) => s + parseFloat(p.amount), 0).toFixed(2)}
                  </span>
                </div>
                {(() => {
                  const adj = cashMemoStaff.rate_type === 'monthly' && cashMemoData.salary
                    ? (cashMemoData.salary.previous_balance_adjustment || 0)
                    : (cashMemoData.previousBalanceAdjustment || 0);
                  return adj !== 0 ? (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">আগের হিসাবের আপডেট</span>
                      <span className={`font-semibold ${adj > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                        {adj > 0 ? '+' : '−'}৳ {Math.abs(adj).toFixed(2)}
                      </span>
                    </div>
                  ) : null;
                })()}
                <div className="flex justify-between text-base pt-2 border-t border-gray-200 mt-2">
                  <span className="font-bold text-gray-900">এখন পাবে</span>
                  <span className="font-extrabold text-[#075B68]">
                    ৳ {(cashMemoStaff.rate_type === 'monthly' && cashMemoData.salary
                      ? cashMemoData.salary.total_due
                      : (
                          cashMemoData.production.reduce((s, p) => s + parseFloat(p.amount), 0)
                          - cashMemoData.payments.reduce((s, p) => s + parseFloat(p.amount), 0)
                          + (cashMemoData.previousBalanceAdjustment || 0)
                        )
                    ).toFixed(2)}
                  </span>
                </div>
              </div>

              <p className="text-center text-xs text-gray-400 mt-6 print:mt-10">— ধন্যবাদ —</p>
            </>
          ) : (
            <p className="text-sm text-gray-500 text-center py-8">ডেটা পাওয়া যায়নি</p>
          )}
        </div>

        {/* PDF তৈরি হওয়ার সময় লোডিং ওভারলে — ক্যাপচার হওয়া কনটেন্টের বাইরে, যাতে PDF-এ না আসে */}
        {sharingPDF && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 print:hidden">
            <div className="bg-white rounded-2xl px-6 py-5 flex flex-col items-center gap-3">
              <Loader2 size={28} className="animate-spin text-[#034B58]" />
              <p className="text-sm font-semibold text-gray-700">একটু অপেক্ষা করুন, তৈরি হচ্ছে...</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // খরচের বিস্তারিত (মজুরী) — সর্বোচ্চ অগ্রাধিকার, প্রিন্ট সবসময় ঠিকভাবে কাজ করার জন্য
  if (showExpenseReport) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center print:bg-white">
        <div id="expense-report-content" className="w-full sm:max-w-sm bg-white min-h-screen p-6">
          <div className="flex items-center justify-between mb-4 print:hidden">
            <button onClick={() => window.history.back()} className="text-gray-400">
              <ChevronRight size={22} className="rotate-180" />
            </button>
            <h2 className="text-lg font-bold text-gray-900">খরচের বিস্তারিত</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  const sections = [];
                  if (allExpenses.length > 0) {
                    sections.push({
                      heading: 'ফ্যাক্টরি খরচ',
                      columns: ['তারিখ', 'বিবরণ', 'টাকা'],
                      rows: allExpenses.map((ex) => [ex.expense_date?.slice(0, 10), ex.description, `৳${ex.amount}`])
                    });
                  }
                  if (allStaffPayments.length > 0) {
                    sections.push({
                      heading: 'কারিগর/স্টাফদের দেওয়া টাকা',
                      columns: ['তারিখ', 'নাম', 'টাকা'],
                      rows: allStaffPayments.map((pay) => [pay.payment_date?.slice(0, 10), pay.staff_name, `৳${pay.amount}`])
                    });
                  }
                  if (allPartnerExpenses.length > 0) {
                    sections.push({
                      heading: 'পার্টনার/এডমিনদের খরচ',
                      columns: ['তারিখ', 'কে', 'কেন', 'টাকা'],
                      rows: allPartnerExpenses.map((pe) => [pe.event_time?.slice(0, 10), pe.added_by_name, pe.description, `৳${pe.amount}`])
                    });
                  }
                  const totalExpenses = allExpenses.reduce((s, e) => s + parseFloat(e.amount), 0);
                  const totalStaffPay = allStaffPayments.reduce((s, p) => s + parseFloat(p.amount), 0);
                  const totalPartnerExp = allPartnerExpenses.reduce((s, p) => s + parseFloat(p.amount), 0);
                  const config = {
                    title: 'Maya Garments',
                    subtitle: 'সম্পূর্ণ খরচের রিপোর্ট',
                    dateLabel: `তারিখ: ${new Date().toLocaleDateString('bn-BD')}`,
                    sections,
                    totals: [
                      ['মোট ফ্যাক্টরি খরচ', `৳ ${totalExpenses.toFixed(2)}`],
                      ['মোট স্টাফ পেমেন্ট', `৳ ${totalStaffPay.toFixed(2)}`],
                      ['মোট পার্টনার/এডমিন খরচ', `৳ ${totalPartnerExp.toFixed(2)}`],
                      ['সর্বমোট খরচ', `৳ ${(totalExpenses + totalStaffPay + totalPartnerExp).toFixed(2)}`, true]
                    ]
                  };
                  shareStructuredPDF(config, 'khoroch-bistarito', 'খরচের বিস্তারিত', 'expense-report-content', {
                    onStart: () => setSharingPDF(true),
                    onFinish: () => setSharingPDF(false),
                    headers: authHeaders()
                  });
                }}
                disabled={sharingPDF}
                className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center active:scale-90 active:bg-emerald-200 transition-transform disabled:opacity-60"
              >
                {sharingPDF ? <Loader2 size={16} className="text-emerald-700 animate-spin" /> : <Share2 size={16} className="text-emerald-700" />}
              </button>
              <button
                onClick={() => window.print()}
                className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center active:scale-90 active:bg-red-200 transition-transform"
              >
                <Printer size={16} className="text-red-800" />
              </button>
            </div>
          </div>

          {/* মেমো হেডার */}
          <div className="text-center border-b-2 border-dashed border-gray-300 pb-4 mb-4">
            <h1 className="text-xl font-extrabold text-[#075B68] tracking-wide">Maya Garments</h1>
            <p className="text-xs text-gray-500 mt-1">চেয়ারম্যান বাড়ির মোড়, কামরাঙ্গীরচর, ঢাকা-১২১১</p>
            <p className="text-xs text-gray-500">যোগাযোগঃ 01783203215, 01762037641</p>
            <p className="text-xs text-gray-500 mt-2">সম্পূর্ণ খরচের রিপোর্ট</p>
            <p className="text-xs text-gray-400 mt-1">তারিখ: {new Date().toLocaleDateString('bn-BD')}</p>
          </div>

          {expenseReportLoading ? (
            <div className="flex justify-center py-10 print:hidden">
              <Loader2 size={28} className="animate-spin text-[#034B58]" />
            </div>
          ) : (
            <>
              {allExpenses.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">ফ্যাক্টরি খরচ</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5">বিবরণ</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {allExpenses.map((ex) => (
                        <tr key={ex.id} className="border-b border-gray-100">
                          <td className="py-1.5">{ex.expense_date?.slice(0, 10)}</td>
                          <td className="py-1.5">{ex.description}</td>
                          <td className="py-1.5 text-right">৳{ex.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {allStaffPayments.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">কারিগর/স্টাফদের দেওয়া টাকা</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5">নাম</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {allStaffPayments.map((pay) => (
                        <tr key={pay.id} className="border-b border-gray-100">
                          <td className="py-1.5">{pay.payment_date?.slice(0, 10)}</td>
                          <td className="py-1.5">{pay.staff_name}</td>
                          <td className="py-1.5 text-right">৳{pay.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {allPartnerExpenses.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-bold text-gray-500 uppercase mb-2">পার্টনার/এডমিনদের খরচ</p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-200 text-gray-500">
                        <td className="py-1.5">তারিখ</td>
                        <td className="py-1.5">কে</td>
                        <td className="py-1.5">কেন</td>
                        <td className="py-1.5 text-right">টাকা</td>
                      </tr>
                    </thead>
                    <tbody>
                      {allPartnerExpenses.map((pe) => (
                        <tr key={pe.id} className="border-b border-gray-100">
                          <td className="py-1.5">{pe.event_time?.slice(0, 10)}</td>
                          <td className="py-1.5">{pe.added_by_name}</td>
                          <td className="py-1.5">{pe.description}</td>
                          <td className="py-1.5 text-right">৳{pe.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {allExpenses.length === 0 && allStaffPayments.length === 0 && allPartnerExpenses.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো খরচ যোগ করা হয়নি</p>
              )}

              {/* টোটাল */}
              <div className="border-t-2 border-dashed border-gray-300 pt-4 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">মোট ফ্যাক্টরি খরচ</span>
                  <span className="font-semibold text-gray-900">
                    ৳ {allExpenses.reduce((s, e) => s + parseFloat(e.amount), 0).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">মোট স্টাফ পেমেন্ট</span>
                  <span className="font-semibold text-gray-900">
                    ৳ {allStaffPayments.reduce((s, p) => s + parseFloat(p.amount), 0).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">মোট পার্টনার/এডমিন খরচ</span>
                  <span className="font-semibold text-gray-900">
                    ৳ {allPartnerExpenses.reduce((s, p) => s + parseFloat(p.amount), 0).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between text-base pt-2 border-t border-gray-200 mt-2">
                  <span className="font-bold text-gray-900">সর্বমোট খরচ</span>
                  <span className="font-extrabold text-[#075B68]">
                    ৳ {(
                      allExpenses.reduce((s, e) => s + parseFloat(e.amount), 0) +
                      allStaffPayments.reduce((s, p) => s + parseFloat(p.amount), 0) +
                      allPartnerExpenses.reduce((s, p) => s + parseFloat(p.amount), 0)
                    ).toFixed(2)}
                  </span>
                </div>
              </div>

              <p className="text-center text-xs text-gray-400 mt-6 print:mt-10">— ধন্যবাদ —</p>
            </>
          )}
        </div>

        {/* PDF তৈরি হওয়ার সময় লোডিং ওভারলে — ক্যাপচার হওয়া কনটেন্টের বাইরে, যাতে PDF-এ না আসে */}
        {sharingPDF && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 print:hidden">
            <div className="bg-white rounded-2xl px-6 py-5 flex flex-col items-center gap-3">
              <Loader2 size={28} className="animate-spin text-[#034B58]" />
              <p className="text-sm font-semibold text-gray-700">একটু অপেক্ষা করুন, তৈরি হচ্ছে...</p>
            </div>
          </div>
        )}
      </div>
    );
  }

  // বিস্তারিত ড্রিল-ডাউন (attendance/production/payments) — ফুল পেজ
  if (staffDetail && detailView) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">
              {detailView === 'attendance' && 'উপস্থিতির বিস্তারিত'}
              {detailView === 'production' && 'প্রোডাকশনের বিস্তারিত'}
              {detailView === 'payments' && 'পেমেন্টের বিস্তারিত'}
            </h1>
          </div>
          <div className="p-4">
            {detailListLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 size={28} className="animate-spin text-[#034B58]" />
              </div>
            ) : detailList.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">কোনো তথ্য পাওয়া যায়নি</p>
            ) : (
              <div className="flex flex-col gap-3">
                {detailView === 'attendance' && detailList.map((d, i) => (
                  <div key={i} className={`bg-white rounded-2xl shadow-md p-4 border-l-4 ${d.status === 'present' ? 'border-emerald-500' : 'border-red-500'}`}>
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-gray-900 text-sm">{d.date}</p>
                      {d.status === 'absent' ? (
                        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-red-50 text-red-700">অনুপস্থিত</span>
                      ) : (
                        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">উপস্থিত</span>
                      )}
                    </div>
                    {d.status === 'present' && (
                      <div className="mt-2 space-y-2">
                        {d.shift1?.attended ? (
                          <div className="bg-sky-50 rounded-lg p-2.5 text-xs text-gray-600">
                            <p className="font-semibold text-sky-800 mb-1">শিফট ১</p>
                            <p>ঢুকেছে: {d.shift1.check_in ? new Date(d.shift1.check_in).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' }) : '—'}</p>
                            <p>
                              বের হয়েছে: {d.shift1.check_out
                                ? new Date(d.shift1.check_out).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })
                                : (d.shift1.shift_end ? `${new Date(d.shift1.shift_end).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })} (ডিউটি টাইম)` : '—')}
                            </p>
                            {d.shift1.late_minutes > 0 && <p className="text-orange-600 font-medium">লেট: {d.shift1.late_minutes} মিনিট</p>}
                            {d.shift1.is_partial && <p className="text-red-600 font-medium">মাঝপথে চলে গেছে</p>}
                          </div>
                        ) : d.shift1?.shift_end ? (
                          <div className="bg-red-50 rounded-lg p-2.5 text-xs">
                            <p className="font-semibold text-red-700">শিফট ১ অনুপস্থিত</p>
                          </div>
                        ) : null}
                        {d.shift2?.attended ? (
                          <div className="bg-indigo-50 rounded-lg p-2.5 text-xs text-gray-600">
                            <p className="font-semibold text-indigo-800 mb-1">শিফট ২</p>
                            <p>ঢুকেছে: {d.shift2.check_in ? new Date(d.shift2.check_in).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' }) : '—'}</p>
                            <p>
                              বের হয়েছে: {d.shift2.check_out
                                ? new Date(d.shift2.check_out).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })
                                : (d.shift2.shift_end ? `${new Date(d.shift2.shift_end).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })} (ডিউটি টাইম)` : '—')}
                            </p>
                            {d.shift2.late_minutes > 0 && <p className="text-orange-600 font-medium">লেট: {d.shift2.late_minutes} মিনিট</p>}
                            {d.shift2.is_partial && <p className="text-red-600 font-medium">মাঝপথে চলে গেছে</p>}
                          </div>
                        ) : d.shift2?.shift_end ? (
                          <div className="bg-red-50 rounded-lg p-2.5 text-xs">
                            <p className="font-semibold text-red-700">শিফট ২ অনুপস্থিত</p>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}

                {detailView === 'production' && detailList.map((p) => (
                  <div key={p.id} className="bg-white rounded-2xl shadow-md p-4 flex items-center justify-between border-l-4 border-amber-500">
                    <div>
                      <p className="font-semibold text-gray-900 text-sm">{p.product_name}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{p.entry_date?.slice(0, 10)} · {p.quantity} পিস</p>
                    </div>
                    <p className="text-sm font-semibold text-[#034B58]">৳ {p.amount}</p>
                  </div>
                ))}

                {detailView === 'payments' && detailList.map((pay) => (
                  <div key={pay.id} className="bg-white rounded-2xl shadow-md p-4 flex items-center justify-between border-l-4 border-emerald-500">
                    <div>
                      <p className="text-xs text-gray-500">{pay.payment_date?.slice(0, 10)}</p>
                      {pay.edited_by_name && (
                        <p className="text-[11px] text-amber-600 mt-0.5">সম্পাদনা করেছেন: {pay.edited_by_name}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-[#034B58]">৳ {pay.amount}</p>
                      <button
                        onClick={() => openEditPayment(pay, staffDetail)}
                        className="w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center"
                      >
                        <Pencil size={12} className="text-amber-700" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* পেমেন্ট এডিট ফর্ম — এই পেজের ভেতরেই, নাহলে এডিট বাটন কাজ করে না */}
        {showWeeklyPicker && weeklyStaff && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">
                  {editingPaymentId && <span className="text-emerald-700 text-xs block mb-0.5">এডিট করছেন</span>}
                  {weeklyStaff.name} — সাপ্তাহিক পেমেন্ট
                </h2>
                <button onClick={() => { setShowWeeklyPicker(false); setWeeklyStaff(null); setEditingPaymentId(null); }} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <label className="text-xs font-semibold text-gray-500">কত টাকা দেওয়া হয়েছে?</label>
              <input
                type="number"
                value={weeklyAmount}
                onChange={(e) => setWeeklyAmount(e.target.value)}
                className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="যেমন: ২০০০"
                autoFocus
              />

              <label className="text-xs font-semibold text-gray-500">কোন তারিখে?</label>
              <input
                type="date"
                value={weeklyPaymentDate}
                onChange={(e) => setWeeklyPaymentDate(e.target.value)}
                className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
              />

              {weeklyError && <p className="text-sm text-red-600 mt-3">{weeklyError}</p>}

              <button
                onClick={submitWeeklyPayment}
                disabled={weeklySubmitting}
                className="w-full mt-5 bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
              >
                {weeklySubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                {weeklySubmitting ? 'সেভ হচ্ছে...' : editingPaymentId ? 'আপডেট করুন' : 'সেভ করুন'}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // স্টাফ বিস্তারিত — ফুল পেজ
  if (staffDetail) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">{staffDetail.name} — বিস্তারিত</h1>
          </div>
          <div className="p-4">
            {staffDetailLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 size={28} className="animate-spin text-[#034B58]" />
              </div>
            ) : (
              <div className="space-y-6">
                {/* ডিউটি/উপস্থিতি */}
                <div>
                  <h3 className="text-sm font-bold text-gray-700 mb-3">গত ৩০ দিনের উপস্থিতি</h3>
                  {staffDetail.attendance ? (
                    <div className="grid grid-cols-2 gap-3">
                      <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-emerald-500 active:opacity-80">
                        <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.present_days}</p>
                        <p className="text-xs text-gray-500 mt-0.5">উপস্থিত দিন</p>
                      </button>
                      <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-red-500 active:opacity-80">
                        <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.absent_days}</p>
                        <p className="text-xs text-gray-500 mt-0.5">অনুপস্থিত দিন</p>
                      </button>
                      <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-sky-500 active:opacity-80">
                        <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.shift1_present_days || 0}</p>
                        <p className="text-xs text-gray-500 mt-0.5">শিফট ১ উপস্থিত</p>
                      </button>
                      <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-indigo-500 active:opacity-80">
                        <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.shift2_present_days || 0}</p>
                        <p className="text-xs text-gray-500 mt-0.5">শিফট ২ উপস্থিত</p>
                      </button>
                      <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-[#034B58] active:opacity-80">
                        <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.present_hours}</p>
                        <p className="text-xs text-gray-500 mt-0.5">উপস্থিত ঘণ্টা</p>
                      </button>
                      <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-amber-500 active:opacity-80">
                        <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.break_hours}</p>
                        <p className="text-xs text-gray-500 mt-0.5">ব্রেক ঘণ্টা</p>
                      </button>
                      <button onClick={() => openDetailView('attendance')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-orange-500 active:opacity-80">
                        <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.late_hours}</p>
                        <p className="text-xs text-gray-500 mt-0.5">মোট লেট (ঘণ্টা)</p>
                      </button>
                      <div className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-cyan-500">
                        <p className="text-2xl font-bold text-gray-900">{staffDetail.attendance.overtime_hours || 0}</p>
                        <p className="text-xs text-gray-500 mt-0.5">মোট ওভারটাইম (ঘণ্টা)</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">ডেটা পাওয়া যায়নি</p>
                  )}
                </div>

                {/* প্রোডাকশন / বেতন */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-bold text-gray-700">
                      {staffDetail.rate_type === 'monthly' ? 'বেতন হিসাব' : 'প্রোডাকশন হিসাব'}
                    </h3>
                    <button
                      onClick={revealSalary}
                      className="text-xs font-semibold text-[#034B58] bg-red-50 rounded-full px-3 py-1.5 flex items-center gap-1"
                    >
                      <Eye size={13} /> {salaryVisible ? 'দেখা যাচ্ছে' : 'বেতন দেখুন'}
                    </button>
                  </div>
                  {staffDetail.rate_type === 'monthly' ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white rounded-2xl shadow-md p-4 border-l-4 border-amber-500">
                        <p className="text-2xl font-bold text-gray-900">{salaryVisible ? `৳ ${staffDetail.rate_amount || 0}` : '৳ ****'}</p>
                        <p className="text-xs text-gray-500 mt-0.5">আপনার বেতন</p>
                      </div>
                      <button onClick={() => openCashMemo(staffDetail)} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-[#034B58] active:opacity-80">
                        <p className="text-2xl font-bold text-gray-900">{salaryVisible ? `৳ ${staffDetail.salary?.total_salary_earned ?? 0}` : '৳ ****'}</p>
                        <p className="text-xs text-gray-500 mt-0.5">আজকে পর্যন্ত মোট বেতন</p>
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <button onClick={() => openDetailView('production')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-amber-500 active:opacity-80">
                        <p className="text-2xl font-bold text-gray-900">{staffDetail.production?.total_quantity || 0}</p>
                        <p className="text-xs text-gray-500 mt-0.5">মোট পিস</p>
                      </button>
                      <button onClick={() => openDetailView('production')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-[#034B58] active:opacity-80">
                        <p className="text-2xl font-bold text-gray-900">{salaryVisible ? `৳ ${staffDetail.production?.total_amount || 0}` : '৳ ****'}</p>
                        <p className="text-xs text-gray-500 mt-0.5">মোট আয়</p>
                      </button>
                    </div>
                  )}
                </div>

                {/* পেমেন্ট + পাওনা */}
                <div>
                  <h3 className="text-sm font-bold text-gray-700 mb-3">সাপ্তাহিক পেমেন্ট হিসাব</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <button onClick={() => openDetailView('payments')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-emerald-500 active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{salaryVisible ? `৳ ${staffDetail.payments?.total_paid || 0}` : '৳ ****'}</p>
                      <p className="text-xs text-gray-500 mt-0.5">মোট দেওয়া হয়েছে</p>
                    </button>
                    <button onClick={() => openDetailView('payments')} className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-gray-300 active:opacity-80">
                      <p className="text-2xl font-bold text-gray-900">{staffDetail.payments?.payment_count || 0}</p>
                      <p className="text-xs text-gray-500 mt-0.5">মোট বার</p>
                    </button>
                    <button
                      onClick={() => openCashMemo(staffDetail)}
                      className="text-left bg-white rounded-2xl shadow-md p-4 border-l-4 border-[#075B68] active:opacity-80 col-span-2"
                    >
                      <p className="text-2xl font-bold text-gray-900">
                        {salaryVisible ? `৳ ${(
                          staffDetail.rate_type === 'monthly'
                            ? parseFloat(staffDetail.salary?.total_due ?? (parseFloat(staffDetail.rate_amount || 0) - parseFloat(staffDetail.payments?.total_paid || 0)))
                            : (parseFloat(staffDetail.production?.total_amount || 0) - parseFloat(staffDetail.payments?.total_paid || 0))
                        ).toFixed(2)}` : '৳ ****'}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">মোট পাওনা — ক্যাশ মেমো দেখতে ক্লিক করুন</p>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // মোট এমপ্লয়ি — ফুল পেজ
  if (showEmployeeModal) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">মোট এমপ্লয়ি ({staffList.length})</h1>
          </div>
          <div className="p-4">
            <div className="relative mb-4">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={staffSearchQuery}
                onChange={(e) => setStaffSearchQuery(e.target.value)}
                placeholder="নাম বা ফোন নাম্বার দিয়ে সার্চ করুন"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#034B58] bg-white"
              />
            </div>
            {staffList.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো স্টাফ যোগ করা হয়নি</p>
            ) : (
              <div className="flex flex-col gap-3">
                {staffList.filter(matchesStaffSearch).map((s) => (
                  <div
                    key={s.id}
                    className={`bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 border-l-4 ${
                      s.rate_type === 'monthly' ? 'border-[#034B58]' : 'border-amber-500'
                    }`}
                  >
                    <div className="min-w-0">
                      <button
                        onClick={() => openStaffDetail(s.id, s.name)}
                        className="font-semibold text-gray-900 text-sm text-left active:text-[#034B58]"
                      >
                        {s.name}
                      </button>
                      <p className="text-xs text-gray-500 mt-0.5">{s.designation || 'পদবি নেই'}</p>
                      {s.phone && (
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-xs text-gray-600">{s.phone}</span>
                          <a
                            href={`tel:${s.phone}`}
                            className="w-7 h-7 rounded-full bg-emerald-100 flex items-center justify-center active:bg-emerald-200"
                          >
                            <Phone size={13} className="text-emerald-700" />
                          </a>
                          <a
                            href={`https://wa.me/${toWhatsAppNumber(s.phone)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center active:bg-green-200"
                          >
                            <MessageCircle size={13} className="text-green-700" />
                          </a>
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      {s.rate_type === 'monthly' ? (
                        <button onClick={() => revealSalaryFor(s.id)} className="text-sm font-semibold text-[#034B58]">
                          {visibleSalaryIds.has(s.id) ? `৳ ${s.rate_amount}` : '৳ ****'}
                        </button>
                      ) : productionSummary[s.id]?.total_amount > 0 ? (
                        <button onClick={() => revealSalaryFor(s.id)} className="text-sm font-semibold text-[#034B58]">
                          {visibleSalaryIds.has(s.id) ? `৳ ${productionSummary[s.id].total_amount}` : '৳ ****'}
                        </button>
                      ) : (
                        <p className="text-sm font-semibold text-gray-400">—</p>
                      )}
                      <p className="text-xs text-gray-400">
                        {s.rate_type === 'monthly' ? 'মাসিক' : 'প্রোডাকশন'}
                      </p>
                      <div className="flex items-center gap-2 mt-2 justify-end">
                        <button
                          onClick={() => startEditStaff(s)}
                          className="w-7 h-7 rounded-full bg-amber-100 flex items-center justify-center"
                        >
                          <Pencil size={13} className="text-amber-700" />
                        </button>
                        <button
                          onClick={() => deleteStaff(s.id, s.name)}
                          className="w-7 h-7 rounded-full bg-red-100 flex items-center justify-center"
                        >
                          <Trash2 size={13} className="text-red-700" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* স্টাফ যোগ/এডিট ফর্ম — এই পেজের ভেতরেই, নাহলে এডিট বাটন কাজ করে না */}
          {showAddForm && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-lg font-bold text-gray-900">
                    {editingStaffId ? 'স্টাফ/কারিগর এডিট করুন' : 'নতুন স্টাফ/কারিগর যোগ করুন'}
                  </h2>
                  <button
                    onClick={() => {
                      setShowAddForm(false);
                      setEditingStaffId(null);
                      setForm({ name: '', phone: '', designation: '', joining_date: '', rate_type: 'piece', rate_amount: '', machine_user_id: '' });
                    }}
                    className="text-gray-400"
                  >
                    <X size={22} />
                  </button>
                </div>

                <form onSubmit={handleAddStaff} className="space-y-4">
                  <div>
                    <label className="text-xs font-semibold text-gray-500">নাম *</label>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                      placeholder="যেমন: করিম মিয়া"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-gray-500">ফোন নাম্বার</label>
                    <input
                      type="text"
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                      placeholder="যেমন: ০১৭xxxxxxxx"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-gray-500">পদবি/কাজের ধরন</label>
                    <input
                      type="text"
                      value={form.designation}
                      onChange={(e) => setForm({ ...form, designation: e.target.value })}
                      className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                      placeholder="যেমন: সেলাই, কাটিং, ফিনিশিং"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-gray-500">যোগদানের তারিখ</label>
                    <input
                      type="date"
                      value={form.joining_date}
                      onChange={(e) => setForm({ ...form, joining_date: e.target.value })}
                      className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-gray-500">মেশিন ইউজার আইডি (ফিঙ্গারপ্রিন্ট)</label>
                    <input
                      type="text"
                      value={form.machine_user_id}
                      onChange={(e) => setForm({ ...form, machine_user_id: e.target.value })}
                      className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                      placeholder="যেমন: 3"
                    />
                    <p className="text-xs text-gray-400 mt-1 leading-snug">
                      প্রথমে মেশিনে গিয়ে এই কারিগরের আঙুলের ছাপ রেকর্ড করুন (User Management থেকে), তারপর মেশিন যে নাম্বারটা দেয় সেটা এখানে বসান। না দিলে ফিঙ্গারপ্রিন্ট দিয়ে উপস্থিতি গণনা হবে না, শুধু ম্যানুয়ালি করতে হবে।
                    </p>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-gray-500">রেটের ধরন</label>
                    <div className="flex gap-3 mt-1">
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, rate_type: 'piece' })}
                        className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border ${form.rate_type === 'piece' ? 'bg-[#075B68] text-white border-[#075B68]' : 'border-gray-200 text-gray-600'}`}
                      >
                        প্রোডাকশন
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, rate_type: 'monthly' })}
                        className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border ${form.rate_type === 'monthly' ? 'bg-[#075B68] text-white border-[#075B68]' : 'border-gray-200 text-gray-600'}`}
                      >
                        মাসিক বেতন
                      </button>
                    </div>
                  </div>

                  {form.rate_type === 'monthly' && (
                    <div>
                      <label className="text-xs font-semibold text-gray-500">মাসিক বেতন (৳)</label>
                      <input
                        type="number"
                        value={form.rate_amount}
                        onChange={(e) => setForm({ ...form, rate_amount: e.target.value })}
                        className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                        placeholder="যেমন: ৮০০০"
                      />
                    </div>
                  )}

                  {formError && (
                    <p className="text-sm text-red-600">{formError}</p>
                  )}

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                  >
                    {submitting ? <Loader2 size={18} className="animate-spin" /> : <UserPlus size={18} />}
                    {submitting ? 'সেভ হচ্ছে...' : editingStaffId ? 'আপডেট করুন' : 'সেভ করুন'}
                  </button>
                </form>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // আজকের উপস্থিতি — ফুল পেজ
  if (showAttendanceModal) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">আজকের উপস্থিতি</h1>
          </div>
          <div className="p-4">
            {(() => {
              const formatTime = (t) => t ? new Date(t).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' }) : null;

              const buildTodayTime = (hm) => {
                const [h, m] = (hm || '00:00').split(':').map(Number);
                const d = new Date();
                d.setHours(h, m, 0, 0);
                return d;
              };
              const now = new Date();
              const shift1StartTime = buildTodayTime(dutyForm.shift1_start);
              const shift1EndTime = buildTodayTime(dutyForm.shift1_end);
              const shift2StartTime = buildTodayTime(dutyForm.shift2_start);
              const shift2EndTime = buildTodayTime(dutyForm.shift2_end);

              const isOffTime = now < shift1StartTime || (now >= shift1EndTime && now < shift2StartTime) || now >= shift2EndTime;

              let emptyMessage = 'এই মুহূর্তে কেউ উপস্থিত নেই';
              if (now < shift1StartTime) {
                emptyMessage = 'ডিউটি টাইম শুরু হয়নি';
              } else if (now >= shift1EndTime && now < shift2StartTime) {
                emptyMessage = 'লাঞ্চ টাইম চলছে';
              } else if (now >= shift2EndTime) {
                emptyMessage = 'ডিউটি টাইম শেষ';
              }

              // ডিউটি শুরুর আগে, লাঞ্চ টাইমে, বা ডিউটি শেষের পরে — এই সময়গুলোতে লিস্ট জোর করে খালি দেখাবে
              const activeToday = isOffTime
                ? []
                : attendanceToday.filter((s) => s.status === 'present' || s.status === 'on_break');

              return activeToday.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">{emptyMessage}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {activeToday.map((s) => {
                    const st = STATUS_LABELS[s.status] || STATUS_LABELS.not_marked;
                    return (
                      <button
                        key={s.staff_id}
                        onClick={() => openStaffDetail(s.staff_id, s.name)}
                        className={`text-left bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 border-l-4 ${st.border} active:opacity-80`}
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-gray-900 text-sm">{s.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{s.designation || 'পদবি নেই'}</p>
                          <div className="text-xs text-gray-500 mt-1.5 space-y-0.5">
                            {s.check_in && <p>উপস্থিতি: {formatTime(s.check_in)}</p>}
                            {s.break_start && (
                              <p>লাঞ্চ: {formatTime(s.break_start)}{s.break_end ? ` - ${formatTime(s.break_end)}` : ' (চলছে)'}</p>
                            )}
                            {s.check_out && <p>ডিউটি শেষ: {formatTime(s.check_out)}</p>}
                            {s.late_minutes > 0 && (
                              <p className="text-orange-600 font-medium">লেট: {s.late_minutes} মিনিট</p>
                            )}
                          </div>
                        </div>
                        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${st.bg} ${st.color} shrink-0`}>
                          {st.text}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    );
  }

  // আজকের অনুপস্থিত — ফুল পেজ
  if (showAbsentModal) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">আজকের অনুপস্থিত</h1>
          </div>
          <div className="p-4">
            {(() => {
              const buildTodayTime = (hm) => {
                const [h, m] = (hm || '00:00').split(':').map(Number);
                const d = new Date();
                d.setHours(h, m, 0, 0);
                return d;
              };
              const now = new Date();
              const shift1StartTime = buildTodayTime(dutyForm.shift1_start);
              const shift1EndTime = buildTodayTime(dutyForm.shift1_end);
              const shift2StartTime = buildTodayTime(dutyForm.shift2_start);
              const shift2EndTime = buildTodayTime(dutyForm.shift2_end);
              const isOffTime = now < shift1StartTime || (now >= shift1EndTime && now < shift2StartTime) || now >= shift2EndTime;

              const absentToday = isOffTime
                ? []
                : attendanceToday.filter((s) => s.status === 'not_marked' || s.status === 'absent');
              return absentToday.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">আজ সবাই উপস্থিত হয়েছে 🎉</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {absentToday.map((s) => (
                    <div
                      key={s.staff_id}
                      className="bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 border-l-4 border-red-500"
                    >
                      <button
                        onClick={() => openStaffDetail(s.staff_id, s.name)}
                        className="min-w-0 text-left"
                      >
                        <p className="font-semibold text-gray-900 text-sm">{s.name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{s.designation || 'পদবি নেই'}</p>
                        {s.phone && (
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-xs text-gray-600">{s.phone}</span>
                            <a
                              href={`tel:${s.phone}`}
                              onClick={(e) => e.stopPropagation()}
                              className="w-7 h-7 rounded-full bg-emerald-100 flex items-center justify-center active:bg-emerald-200"
                            >
                              <Phone size={13} className="text-emerald-700" />
                            </a>
                            <a
                              href={`https://wa.me/${toWhatsAppNumber(s.phone)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="w-7 h-7 rounded-full bg-green-100 flex items-center justify-center active:bg-green-200"
                            >
                              <MessageCircle size={13} className="text-green-700" />
                            </a>
                          </div>
                        )}
                      </button>
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-red-50 text-red-700 shrink-0">
                        অনুপস্থিত
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    );
  }

  // কারিগর হিসাব — Step 1 (কোন কারিগর?) — ফুল পেজ, বাকি ২ ধাপ পপআপ হিসেবে থাকবে
  if (showKarigorHisab && karigorStep === 'select-staff') {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">কোন কারিগর?</h1>
          </div>
          <div className="p-4">
            <div className="relative mb-4">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={staffSearchQuery}
                onChange={(e) => setStaffSearchQuery(e.target.value)}
                placeholder="নাম বা ফোন নাম্বার দিয়ে সার্চ করুন"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#034B58] bg-white"
              />
            </div>
            {staffList.filter((s) => s.rate_type !== 'monthly').length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো প্রোডাকশন-টাইপ কারিগর যোগ করা হয়নি</p>
            ) : (
              <div className="flex flex-col gap-3">
                {staffList.filter((s) => s.rate_type !== 'monthly').filter(matchesStaffSearch).map((s) => {
                  const recent = recentProduction[s.id];
                  return (
                    <div key={s.id} className="bg-white rounded-2xl shadow-md p-4 border-l-4 border-amber-500">
                      <button
                        onClick={() => { setKarigorStaff(s); setKarigorStep('select-product'); }}
                        className="w-full text-left flex items-center justify-between gap-3 active:opacity-80"
                      >
                        <p className="font-semibold text-gray-900 text-sm">{s.name}</p>
                        <p className="text-xs text-gray-500">{s.designation || 'পদবি নেই'}</p>
                      </button>
                      {recent && (
                        <button
                          onClick={() => openEditProductionEntry(recent, s)}
                          className="mt-2 w-full text-left text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg px-3 py-1.5"
                        >
                          ইতিমধ্যে একবার হিসাব যোগ করা হয়েছে — এডিট করতে ট্যাপ করুন
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // কারিগর হিসাব — Step 2 (কোন প্রোডাক্ট?) — ফুল পেজ, শুধু পিস সংখ্যার ধাপ পপআপ হিসেবে থাকবে
  if (showKarigorHisab && karigorStep === 'select-product') {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">{karigorStaff?.name} — কোন প্রোডাক্ট?</h1>
          </div>
          <div className="p-4">
            {products.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো প্রোডাক্ট যোগ করা হয়নি</p>
            ) : (
              <div className="flex flex-col gap-3">
                {products.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setKarigorProduct(p);
                      setKarigorStep('enter-qty');
                      const now = new Date();
                      setKarigorEntryDate(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
                    }}
                    className="text-left bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 border-l-4 border-amber-500 active:opacity-80"
                  >
                    <p className="font-semibold text-gray-900 text-sm">{p.name}</p>
                    <p className="text-sm font-semibold text-[#034B58]">৳ {p.sewing_price} / পিস</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // স্টাফ/কারিগরের সাপ্তাহিক — কাকে দিবেন — ফুল পেজ, টাকার পরিমাণের ধাপ পপআপ হিসেবে থাকবে
  if (showWeeklyPicker && !weeklyStaff) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">কাকে দিবেন?</h1>
          </div>
          <div className="p-4">
            <div className="relative mb-4">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={staffSearchQuery}
                onChange={(e) => setStaffSearchQuery(e.target.value)}
                placeholder="নাম বা ফোন নাম্বার দিয়ে সার্চ করুন"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#034B58] bg-white"
              />
            </div>
            <div className="flex flex-col gap-3">
              {staffList.filter(matchesStaffSearch).map((s) => {
                const recent = recentPayments[s.id];
                return (
                  <div key={s.id} className="bg-white rounded-2xl shadow-md p-4 border-l-4 border-amber-500">
                    <button
                      onClick={() => {
                        setWeeklyStaff(s);
                        const now = new Date();
                        setWeeklyPaymentDate(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
                      }}
                      className="w-full text-left flex items-center justify-between gap-3 active:opacity-80"
                    >
                      <p className="font-semibold text-gray-900 text-sm">{s.name}</p>
                      <p className="text-xs text-gray-500">{s.designation || 'পদবি নেই'}</p>
                    </button>
                    {recent && (
                      <button
                        onClick={() => openEditPayment(recent, s)}
                        className="mt-2 w-full text-left text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg px-3 py-1.5"
                      >
                        ইতিমধ্যে একবার হিসাব যোগ করা হয়েছে — এডিট করতে ট্যাপ করুন
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // পার্টনার বিস্তারিত — ফুল পেজ, "খরচ/ক্যাশ যোগ করুন" ফর্ম আর "কে রিয়েক্ট দিয়েছে" পপআপ হিসেবে থাকবে
  if (selectedPartner) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10 relative">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            {selectedPartner.photo_url ? (
              <img src={selectedPartner.photo_url} alt="" className="w-8 h-8 rounded-full object-cover" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-amber-500 text-[#075B68] flex items-center justify-center font-bold text-sm">
                {selectedPartner.name.charAt(0).toUpperCase()}
              </div>
            )}
            <h1 className="text-base font-bold">{selectedPartner.name}</h1>
          </div>

          <div className="p-4">
            {currentUser?.id === selectedPartner.id && (
              <div className="flex gap-3 mb-4">
                <button
                  onClick={() => openAddPartnerTxn('expense')}
                  className="flex-1 bg-[#075B68] text-white rounded-full py-2.5 text-sm font-semibold flex items-center justify-center gap-2 active:bg-[#034B58]"
                >
                  <CreditCard size={16} /> খরচ যোগ করুন
                </button>
                <button
                  onClick={() => openAddPartnerTxn('cash_in')}
                  className="flex-1 bg-emerald-600 text-white rounded-full py-2.5 text-sm font-semibold flex items-center justify-center gap-2 active:bg-emerald-700"
                >
                  <Wallet size={16} /> ক্যাশ যোগ করুন
                </button>
              </div>
            )}

            {partnerDetailLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 size={28} className="animate-spin text-[#034B58]" />
              </div>
            ) : (
              <>
                {partnerSummary && (
                  <div className="bg-white rounded-2xl shadow-md border-2 border-gray-200 p-4 mb-4">
                    <div className="flex justify-between text-sm mb-1.5">
                      <span className="text-gray-600">মোট ক্যাশ</span>
                      <span className="font-semibold text-emerald-700">৳ {partnerSummary.total_cash_in.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm mb-1.5">
                      <span className="text-gray-600">মোট খরচ</span>
                      <span className="font-semibold text-red-700">৳ {partnerSummary.total_expense.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-base pt-2 border-t border-gray-200 mt-1">
                      <span className="font-bold text-gray-900">বর্তমান ব্যালেন্স</span>
                      <span className="font-extrabold text-[#075B68]">৳ {partnerSummary.balance.toFixed(2)}</span>
                    </div>
                  </div>
                )}

                {partnerTransactions.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো এন্ট্রি নেই</p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {partnerTransactions.map((t) => (
                      <div
                        key={t.id}
                        className="bg-white rounded-2xl shadow-sm border border-gray-200 p-3.5 relative"
                        onTouchStart={() => startLongPress(t.id)}
                        onTouchEnd={cancelLongPress}
                        onMouseDown={() => startLongPress(t.id)}
                        onMouseUp={cancelLongPress}
                        onMouseLeave={cancelLongPress}
                      >
                        {reactingTxnId === t.id && (
                          <div className="absolute -top-11 left-1/2 -translate-x-1/2 z-20 bg-white rounded-full shadow-lg border border-gray-200 flex items-center gap-1 px-2 py-1.5">
                            <button
                              onClick={() => submitReaction(t.id, 'like', t.my_reaction)}
                              className="text-xl active:scale-125 transition-transform px-1"
                            >
                              👍
                            </button>
                            <button
                              onClick={() => submitReaction(t.id, 'love', t.my_reaction)}
                              className="text-xl active:scale-125 transition-transform px-1"
                            >
                              ❤️
                            </button>
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm text-gray-900">{t.description}</p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {new Date(t.event_time).toLocaleString('bn-BD')}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`text-sm font-bold ${t.type === 'cash_in' ? 'text-emerald-700' : 'text-red-700'}`}>
                              {t.type === 'cash_in' ? '+' : '−'}৳{t.amount}
                            </span>
                            {t.added_by_user_id === currentUser?.id && (
                              <button
                                onClick={() => openEditPartnerTxn(t)}
                                className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center"
                              >
                                <Pencil size={13} className="text-amber-700" />
                              </button>
                            )}
                          </div>
                        </div>
                        {t.reaction_counts && Object.keys(t.reaction_counts).length > 0 && (
                          <button
                            onClick={() => setViewingReactorsTxn(t)}
                            className="flex items-center gap-2 mt-2"
                          >
                            {Object.entries(t.reaction_counts).map(([type, count]) => (
                              <span key={type} className="text-xs bg-gray-50 rounded-full px-2 py-0.5">
                                {type === 'like' ? '👍' : '❤️'} {count}
                              </span>
                            ))}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* কে রিয়েক্ট দিয়েছে */}
          {viewingReactorsTxn && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setViewingReactorsTxn(null)}>
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">কে রিয়েক্ট দিয়েছে</h2>
                  <button onClick={() => setViewingReactorsTxn(null)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {(viewingReactorsTxn.reactors || []).map((r, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 bg-gray-50 rounded-xl px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="text-lg">{r.reaction_type === 'like' ? '👍' : '❤️'}</span>
                        <span className="text-sm text-gray-800">{r.user_name}</span>
                      </div>
                      {r.user_id === currentUser?.id && (
                        <button
                          onClick={() => removeMyReactionFromViewer(viewingReactorsTxn.id)}
                          className="text-xs font-semibold text-red-600 bg-red-50 rounded-full px-3 py-1"
                        >
                          সরিয়ে ফেলুন
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* নতুন/এডিট এন্ট্রি ফর্ম */}
          {partnerTxnForm && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-lg font-bold text-gray-900">
                    {partnerTxnForm.editingId
                      ? 'এন্ট্রি এডিট করুন'
                      : partnerTxnForm.type === 'expense'
                      ? 'খরচ যোগ করুন'
                      : 'ক্যাশ যোগ করুন'}
                  </h2>
                  <button onClick={() => setPartnerTxnForm(null)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>

                <label className="text-xs font-semibold text-gray-500">
                  {partnerTxnForm.type === 'expense' ? 'কি কাজে খরচ হয়েছে?' : 'এই ক্যাশ কোথা থেকে এসেছে?'}
                </label>
                <input
                  type="text"
                  value={partnerTxnForm.description}
                  onChange={(e) => setPartnerTxnForm({ ...partnerTxnForm, description: e.target.value })}
                  className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder={partnerTxnForm.type === 'expense' ? 'যেমন: কাপড় কেনা' : 'যেমন: ব্যাংক থেকে তোলা'}
                  autoFocus
                />

                <label className="text-xs font-semibold text-gray-500 mt-4 block">কত টাকা?</label>
                <input
                  type="number"
                  value={partnerTxnForm.amount}
                  onChange={(e) => setPartnerTxnForm({ ...partnerTxnForm, amount: e.target.value })}
                  className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="যেমন: ৫০০০"
                />

                <label className="text-xs font-semibold text-gray-500 mt-4 block">ছবি (ঐচ্ছিক)</label>
                <label className="mt-1 flex items-center gap-3 border border-dashed border-gray-300 rounded-xl px-4 py-3 cursor-pointer">
                  {partnerTxnForm.image_url ? (
                    <img src={partnerTxnForm.image_url} alt="" className="w-14 h-14 rounded-lg object-cover" />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-gray-100 flex items-center justify-center">
                      <PlusCircle size={20} className="text-gray-400" />
                    </div>
                  )}
                  <span className="text-xs text-gray-500">
                    {partnerTxnForm.image_url ? 'ছবি বদলাতে ট্যাপ করুন' : 'ছবি সিলেক্ট করুন (ছবি ছাড়াও পোস্ট করা যাবে)'}
                  </span>
                  <input type="file" accept="image/*" onChange={handlePartnerTxnImageChange} className="hidden" />
                </label>

                {partnerTxnError && <p className="text-sm text-red-600 mt-3">{partnerTxnError}</p>}

                <button
                  onClick={submitPartnerTxn}
                  disabled={partnerTxnSubmitting}
                  className="w-full mt-5 bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                >
                  {partnerTxnSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                  {partnerTxnSubmitting ? 'সেভ হচ্ছে...' : partnerTxnForm.editingId ? 'আপডেট করুন' : 'সেভ করুন'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ওভারটাইম — ফুল পেজ
  if (showOvertimePage) {
    const monthlyStaff = staffList.filter((s) => s.rate_type === 'monthly');
    const activeStaffIds = overtimeActiveSessions.map((o) => o.staff_id);

    if (overtimeView === 'start-select') {
      return (
        <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
          <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-24">
            <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
              <button onClick={() => window.history.back()} className="text-white shrink-0">
                <ChevronRight size={20} className="rotate-180" />
              </button>
              <h1 className="text-base font-bold">কে কে ওভারটাইম করবে সিলেক্ট করুন</h1>
            </div>
            <div className="p-4">
              <div className="relative mb-4">
                <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={staffSearchQuery}
                  onChange={(e) => setStaffSearchQuery(e.target.value)}
                  placeholder="নাম বা ফোন নাম্বার দিয়ে সার্চ করুন"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#034B58] bg-white"
                />
              </div>
              {monthlyStaff.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">মাসিক বেতনের কোনো স্টাফ নেই</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {monthlyStaff.filter(matchesStaffSearch).map((s) => {
                    const alreadyActive = activeStaffIds.includes(s.id);
                    const selected = overtimeSelectedStaff.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        onClick={() => !alreadyActive && toggleOvertimeStaff(s.id)}
                        disabled={alreadyActive}
                        className={`text-left bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 border-l-4 ${
                          alreadyActive ? 'border-gray-300 opacity-60' : selected ? 'border-emerald-600' : 'border-amber-500'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-gray-900 text-sm">{s.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{s.designation || 'পদবি নেই'}</p>
                        </div>
                        {alreadyActive ? (
                          <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-500 shrink-0">
                            চলছে
                          </span>
                        ) : (
                          <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 ${selected ? 'bg-emerald-600 border-emerald-600' : 'border-gray-300'}`}>
                            {selected && <CheckCircle2 size={16} className="text-white" />}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {overtimeSelectedStaff.length > 0 && (
              <div className="fixed bottom-0 w-full sm:max-w-sm bg-white border-t border-gray-200 p-3">
                <button
                  onClick={submitOvertimeStart}
                  disabled={overtimeStarting}
                  className="w-full bg-emerald-600 text-white rounded-full py-3 font-semibold text-sm flex items-center justify-center gap-2 active:bg-emerald-700 disabled:opacity-60"
                >
                  {overtimeStarting ? <Loader2 size={18} className="animate-spin" /> : <LogIn size={18} />}
                  {overtimeStarting ? 'শুরু হচ্ছে...' : `${overtimeSelectedStaff.length} জনের ওভারটাইম শুরু করুন`}
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">ওভারটাইম</h1>
          </div>

          <div className="p-4">
            <div className="flex gap-3 mb-5">
              <button
                onClick={() => setOvertimeView('start-select')}
                className="flex-1 bg-emerald-600 text-white rounded-full py-3 text-sm font-semibold flex items-center justify-center gap-2 active:bg-emerald-700"
              >
                <LogIn size={16} /> ওভারটাইম শুরু করুন
              </button>
              <button
                onClick={() => setShowOvertimeEndConfirm(true)}
                disabled={overtimeActiveSessions.length === 0}
                className="flex-1 bg-[#075B68] text-white rounded-full py-3 text-sm font-semibold flex items-center justify-center gap-2 active:bg-[#034B58] disabled:opacity-40"
              >
                <LogOut size={16} /> ওভারটাইম শেষ করুন
              </button>
            </div>

            {overtimeEndResult && (
              <div className="bg-white rounded-2xl shadow-md border-2 border-emerald-200 p-4 mb-4">
                <p className="text-sm font-bold text-emerald-700 mb-2">✅ ওভারটাইম শেষ হয়েছে</p>
                <div className="flex flex-col gap-2">
                  {overtimeEndResult.map((r) => (
                    <div key={r.staff_id} className="flex items-center justify-between text-sm">
                      <span className="text-gray-800">{r.staff_name}</span>
                      <span className="font-semibold text-gray-900">{r.hours} ঘণ্টা · ৳ {r.amount}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <h3 className="text-sm font-bold text-gray-700 mb-3">এই মুহূর্তে চলমান ওভারটাইম</h3>
            {overtimeActiveSessions.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখন কারো ওভারটাইম চলছে না</p>
            ) : (
              <div className="flex flex-col gap-3">
                {overtimeActiveSessions.map((o) => (
                  <div key={o.id} className="bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 border-l-4 border-cyan-500">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 text-sm">{o.staff_name}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        শুরু: {new Date(o.start_time).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-cyan-50 text-cyan-700 shrink-0">
                      চলছে
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* ওভারটাইম লগ — আগের হিস্ট্রি */}
            <h3 className="text-sm font-bold text-gray-700 mb-3 mt-6">ওভারটাইম লগ</h3>
            {overtimeLog.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো ওভারটাইম রেকর্ড নেই</p>
            ) : (
              <div className="flex flex-col gap-3">
                {overtimeLog.map((o) => (
                  <div key={o.id} className="bg-white rounded-2xl shadow-sm p-4 border-l-4 border-gray-300">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold text-gray-900 text-sm">{o.staff_name}</p>
                      <span className="text-sm font-bold text-[#034B58]">৳ {o.amount}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {new Date(o.start_time).toLocaleDateString('bn-BD')} · {new Date(o.start_time).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })} - {new Date(o.end_time).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' })} · {o.hours} ঘণ্টা
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ওভারটাইম শেষ করার কনফার্মেশন */}
          {showOvertimeEndConfirm && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">ওভারটাইম শেষ করুন</h2>
                  <button onClick={() => setShowOvertimeEndConfirm(false)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>
                <p className="text-sm text-gray-600 mb-5">
                  সত্যি ওভারটাইম শেষ করতে চাচ্ছেন? এই মুহূর্তে চলমান {overtimeActiveSessions.length} জনের ঘণ্টা হিসাব করে তাদের বেতনে যোগ হয়ে যাবে।
                </p>
                <button
                  onClick={confirmOvertimeEnd}
                  disabled={overtimeEnding}
                  className="w-full bg-[#075B68] text-white rounded-full py-3 font-semibold text-sm flex items-center justify-center gap-2 active:bg-[#034B58] disabled:opacity-60"
                >
                  {overtimeEnding ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                  {overtimeEnding ? 'হিসাব হচ্ছে...' : 'হ্যাঁ, শেষ করুন'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // পাইকার — প্রোডাক্টের রেইট যুক্ত করুন — ফুল পেজ
  if (showWholesalerRatePage) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">প্রোডাক্টের রেইট যুক্ত করুন</h1>
          </div>

          <div className="p-4">
            <h3 className="text-sm font-bold text-gray-700 mb-3">কোন পাইকার?</h3>
            {wholesalers.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো পাইকার যোগ করা হয়নি</p>
            ) : (
              <div className="flex flex-col gap-3 mb-5">
                {wholesalers.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => selectWholesalerForRate(w)}
                    className={`text-left bg-white rounded-2xl shadow-md p-4 border-l-4 active:opacity-80 ${
                      selectedWholesalerForRate?.id === w.id ? 'border-violet-600' : 'border-gray-200'
                    }`}
                  >
                    <p className="font-semibold text-gray-900 text-sm">{w.name}</p>
                    {w.phone && <p className="text-xs text-gray-500 mt-0.5">{w.phone}</p>}
                  </button>
                ))}
              </div>
            )}

            {selectedWholesalerForRate && (
              <>
                <h3 className="text-sm font-bold text-gray-700 mb-3">{selectedWholesalerForRate.name} — প্রোডাক্ট রেট</h3>

                {wholesalerRates.length > 0 && (
                  <div className="flex flex-col gap-2.5 mb-4">
                    {wholesalerRates.map((r) => (
                      <div key={r.id} className="bg-white rounded-2xl shadow-sm p-3.5 flex items-center justify-between gap-3 border-l-4 border-gray-200">
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900">{r.product_name}</p>
                          <p className="text-sm font-semibold text-[#034B58]">৳ {r.price}</p>
                        </div>
                        <button
                          onClick={() => startEditRate(r)}
                          className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0"
                        >
                          <Pencil size={13} className="text-amber-700" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="bg-white rounded-2xl shadow-md p-4 border-2 border-violet-200">
                  <p className="text-xs font-bold text-violet-700 mb-2">
                    {editingRateId ? 'রেট এডিট করুন' : 'নতুন রেট যোগ করুন'}
                  </p>
                  <label className="text-xs font-semibold text-gray-500">প্রোডাক্টের নাম</label>
                  <input
                    type="text"
                    value={wholesalerRateForm.product_name}
                    onChange={(e) => setWholesalerRateForm({ ...wholesalerRateForm, product_name: e.target.value })}
                    className="w-full mt-1 mb-3 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: আবায়া মডেল ৫"
                  />
                  <label className="text-xs font-semibold text-gray-500">দাম</label>
                  <input
                    type="number"
                    value={wholesalerRateForm.price}
                    onChange={(e) => setWholesalerRateForm({ ...wholesalerRateForm, price: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: ৮৫০"
                  />
                  <button
                    onClick={submitWholesalerRate}
                    disabled={wholesalerRateSubmitting}
                    className="w-full mt-4 bg-violet-700 text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-violet-800 disabled:opacity-60"
                  >
                    {wholesalerRateSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                    {wholesalerRateSubmitting ? 'সেভ হচ্ছে...' : editingRateId ? 'আপডেট করুন' : 'সেভ করুন'}
                  </button>
                  {editingRateId && (
                    <button onClick={cancelEditRate} className="w-full text-center text-sm text-gray-500 py-2 mt-1">
                      বাতিল করুন
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // পাইকার — ফুল পেজ (পাইকার যুক্ত করুন + প্রোডাক্ট রেট যুক্ত করুন)
  if (showWholesalerPage) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">পাইকার</h1>
          </div>

          <div className="p-4">
            <div className="flex gap-3 mb-5">
              <button
                onClick={openAddWholesalerForm}
                className="flex-1 bg-violet-700 text-white rounded-full py-3 text-sm font-semibold flex items-center justify-center gap-2 active:bg-violet-800"
              >
                <UserPlus size={16} /> পাইকার যুক্ত করুন
              </button>
              <button
                onClick={openWholesalerRatePage}
                className="flex-1 bg-[#075B68] text-white rounded-full py-3 text-sm font-semibold flex items-center justify-center gap-2 active:bg-[#034B58]"
              >
                <CreditCard size={16} /> প্রোডাক্টের রেইট যুক্ত করুন
              </button>
            </div>

            <h3 className="text-sm font-bold text-gray-700 mb-3">পাইকারদের লিস্ট</h3>
            {wholesalers.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো পাইকার যোগ করা হয়নি</p>
            ) : (
              <div className="flex flex-col gap-3">
                {wholesalers.map((w) => (
                  <div key={w.id} className="bg-white rounded-2xl shadow-md p-4 border-l-4 border-violet-500">
                    <p className="font-semibold text-gray-900 text-sm">{w.name}</p>
                    {w.phone && <p className="text-xs text-gray-500 mt-0.5">{w.phone}</p>}
                    {w.address && <p className="text-xs text-gray-400 mt-0.5">{w.address}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* পাইকার যুক্ত করুন — পপআপ */}
          {showAddWholesalerForm && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-lg font-bold text-gray-900">{editingWholesalerId ? 'পাইকার এডিট করুন' : 'পাইকার যুক্ত করুন'}</h2>
                  <button onClick={() => { setShowAddWholesalerForm(false); setEditingWholesalerId(null); }} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>

                <label className="text-xs font-semibold text-gray-500">পাইকারের নাম *</label>
                <input
                  type="text"
                  value={wholesalerForm.name}
                  onChange={(e) => setWholesalerForm({ ...wholesalerForm, name: e.target.value })}
                  className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="যেমন: করিম ট্রেডার্স"
                />

                <label className="text-xs font-semibold text-gray-500">ঠিকানা</label>
                <input
                  type="text"
                  value={wholesalerForm.address}
                  onChange={(e) => setWholesalerForm({ ...wholesalerForm, address: e.target.value })}
                  className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="যেমন: নিউমার্কেট, ঢাকা"
                />

                <label className="text-xs font-semibold text-gray-500">ফোন নাম্বার</label>
                <input
                  type="text"
                  value={wholesalerForm.phone}
                  onChange={(e) => setWholesalerForm({ ...wholesalerForm, phone: e.target.value })}
                  className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="যেমন: ০১৭xxxxxxxx"
                />

                {wholesalerError && <p className="text-sm text-red-600 mt-3">{wholesalerError}</p>}

                <button
                  onClick={submitWholesaler}
                  disabled={wholesalerSubmitting}
                  className="w-full mt-5 bg-violet-700 text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-violet-800 disabled:opacity-60"
                >
                  {wholesalerSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                  {wholesalerSubmitting ? 'সেভ হচ্ছে...' : 'সেভ করুন'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // পাইকারি হিসাব — একজন পাইকারের সম্পূর্ণ হিসাব — ফুল পেজ
  if (selectedWholesalerForAccount) {
    const w = selectedWholesalerForAccount;
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">{w.name}</h1>
          </div>

          <div className="p-4">
            {/* ৪টা ট্যাব */}
            <div className="grid grid-cols-4 gap-2 mb-4">
              <button onClick={() => setShowProductRefList(true)} className="bg-white rounded-xl shadow-sm p-2.5 flex flex-col items-center gap-1 border border-gray-200">
                <Package size={18} className="text-indigo-700" />
                <span className="text-[10px] font-semibold text-gray-700 text-center">প্রোডাক্ট</span>
              </button>
              <button onClick={() => openLedgerForm('add')} className="bg-white rounded-xl shadow-sm p-2.5 flex flex-col items-center gap-1 border border-gray-200">
                <PlusCircle size={18} className="text-amber-700" />
                <span className="text-[10px] font-semibold text-gray-700 text-center">হিসাব যোগ করুন</span>
              </button>
              <button onClick={() => openLedgerForm('return')} className="bg-white rounded-xl shadow-sm p-2.5 flex flex-col items-center gap-1 border border-gray-200">
                <RefreshCw size={18} className="text-red-700" />
                <span className="text-[10px] font-semibold text-gray-700 text-center">রিটার্ন যোগ করুন</span>
              </button>
              <button onClick={openPaymentForm} className="bg-white rounded-xl shadow-sm p-2.5 flex flex-col items-center gap-1 border border-gray-200">
                <Wallet size={18} className="text-emerald-700" />
                <span className="text-[10px] font-semibold text-gray-700 text-center">পেমেন্ট রিসিভ করুন</span>
              </button>
            </div>

            <div id="wholesaler-account-content">
            <div className="text-center border-b-2 border-dashed border-gray-300 pb-4 mb-4">
              <h1 className="text-xl font-extrabold text-[#075B68] tracking-wide">Maya Garments</h1>
              <p className="text-xs text-gray-500 mt-1">চেয়ারম্যান বাড়ির মোড়, কামরাঙ্গীরচর, ঢাকা-১২১১</p>
              <p className="text-xs text-gray-500">যোগাযোগঃ 01783203215, 01762037641</p>
              <p className="text-xs text-gray-500 mt-2">পাইকারি হিসাব — {selectedWholesalerForAccount?.name}</p>
              <p className="text-xs text-gray-400 mt-1">তারিখ: {new Date().toLocaleDateString('bn-BD')}</p>
            </div>
            {/* সামারি */}
            {wholesalerAccountSummary && (
              <div className="bg-white rounded-2xl shadow-md border-2 border-gray-200 p-4 mb-4">
                <div className="flex justify-between text-sm mb-1.5">
                  <span className="text-gray-600">মোট মূল্য</span>
                  <span className="font-semibold text-gray-900">৳ {wholesalerAccountSummary.total_value}</span>
                </div>
                <div className="flex justify-between text-sm mb-1.5">
                  <span className="text-gray-600">মোট পরিশোধ</span>
                  <span className="font-semibold text-emerald-700">৳ {wholesalerAccountSummary.total_paid}</span>
                </div>
                <div className="flex justify-between text-base pt-2 border-t border-gray-200 mt-1">
                  <span className="font-bold text-gray-900">বর্তমান দেনা</span>
                  <span className="font-extrabold text-[#075B68]">৳ {wholesalerAccountSummary.current_due}</span>
                </div>
              </div>
            )}

            {/* লগ */}
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-gray-700">লগ</h3>
              <button
                onClick={shareWholesalerFullAccount}
                disabled={sharingPDF}
                className="w-8 h-8 rounded-full bg-sky-100 flex items-center justify-center disabled:opacity-60 print:hidden"
              >
                {sharingPDF ? <Loader2 size={14} className="animate-spin text-sky-700" /> : <Share2 size={14} className="text-sky-700" />}
              </button>
            </div>
            {wholesalerLedger.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো এন্ট্রি নেই</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {wholesalerLedger.map((entry) => {
                  const borderColor =
                    entry.entry_type === 'payment' ? 'border-red-500' :
                    entry.entry_type === 'add' ? 'border-emerald-500' :
                    'border-gray-900'; // রিটার্ন = কালো
                  return (
                    <div key={entry.id} className={`wholesaler-log-entry bg-white rounded-2xl shadow-sm p-3.5 flex items-center justify-between gap-3 border-l-4 ${borderColor}`}>
                      <div className="min-w-0">
                        <p className="text-sm text-gray-900">
                          {entry.entry_type === 'return' && <span className="text-gray-900 font-semibold">রিটার্ন — </span>}
                          {entry.entry_type === 'payment'
                            ? entry.description
                            : `${entry.product_name} × ${entry.quantity} (৳${entry.price_per_unit}/পিস)`}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {new Date(entry.event_time).toLocaleString('bn-BD')}
                          {entry.added_by_name && <span> · {entry.added_by_name} যোগ করেছেন</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-sm font-bold ${
                          entry.entry_type === 'add' ? 'text-emerald-600' : entry.entry_type === 'return' ? 'text-gray-900' : 'text-red-600'
                        }`}>
                          {entry.entry_type === 'add' ? '+' : '−'}৳{entry.amount}
                        </span>
                        <button
                          onClick={() => entry.entry_type === 'payment' ? startEditPayment(entry) : startEditLedgerEntry(entry)}
                          className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center print:hidden"
                        >
                          <Pencil size={13} className="text-amber-700" />
                        </button>
                        <button
                          onClick={() => deleteLedgerEntry(entry.id)}
                          className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center print:hidden"
                        >
                          <Trash2 size={13} className="text-red-700" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            </div>
          </div>

          {/* প্রোডাক্ট রেফারেন্স লিস্ট */}
          {showProductRefList && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-lg font-bold text-gray-900">প্রোডাক্ট রেট</h2>
                  <button onClick={() => setShowProductRefList(false)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>
                {wholesalerAccountProducts.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো প্রোডাক্ট রেট যোগ করা হয়নি</p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {wholesalerAccountProducts.map((p) => (
                      <div key={p.id} className="bg-gray-50 rounded-xl p-3.5 flex items-center justify-between">
                        <p className="text-sm text-gray-900">{p.product_name}</p>
                        <p className="text-sm font-semibold text-[#034B58]">৳ {p.price} / পিস</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* হিসাব/রিটার্ন যোগ করুন ফর্ম */}
          {ledgerForm && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-lg font-bold text-gray-900">
                    {ledgerForm.editingId ? 'এন্ট্রি এডিট করুন' : ledgerForm.type === 'add' ? 'হিসাব যোগ করুন' : 'রিটার্ন যোগ করুন'}
                  </h2>
                  <button onClick={() => setLedgerForm(null)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>

                {!ledgerForm.product_name ? (
                  <>
                    <p className="text-xs font-semibold text-gray-500 mb-3">কোন প্রোডাক্ট?</p>
                    {wholesalerAccountProducts.length === 0 ? (
                      <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো প্রোডাক্ট রেট যোগ করা হয়নি</p>
                    ) : (
                      <div className="flex flex-col gap-2.5">
                        {wholesalerAccountProducts.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => setLedgerForm({ ...ledgerForm, product_name: p.product_name })}
                            className="text-left bg-white rounded-2xl shadow-md p-4 flex items-center justify-between border-l-4 border-amber-500 active:opacity-80"
                          >
                            <p className="font-semibold text-gray-900 text-sm">{p.product_name}</p>
                            <p className="text-sm font-semibold text-[#034B58]">৳ {p.price} / পিস</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-sm font-semibold text-gray-900 mb-3">{ledgerForm.product_name}</p>
                    <label className="text-xs font-semibold text-gray-500">কত পিস?</label>
                    <input
                      type="number"
                      value={ledgerForm.quantity}
                      onChange={(e) => setLedgerForm({ ...ledgerForm, quantity: e.target.value })}
                      className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                      placeholder="যেমন: ৫"
                      autoFocus
                    />

                    {ledgerFormError && <p className="text-sm text-red-600 mt-3">{ledgerFormError}</p>}

                    <button
                      onClick={submitLedgerForm}
                      disabled={ledgerSubmitting}
                      className="w-full mt-5 bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                    >
                      {ledgerSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                      {ledgerSubmitting ? 'সেভ হচ্ছে...' : ledgerForm.editingId ? 'আপডেট করুন' : 'সেভ করুন'}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* পেমেন্ট রিসিভ করুন ফর্ম */}
          {paymentForm && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-lg font-bold text-gray-900">{paymentForm.editingId ? 'পেমেন্ট এডিট করুন' : 'পেমেন্ট রিসিভ করুন'}</h2>
                  <button onClick={() => setPaymentForm(null)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>

                <label className="text-xs font-semibold text-gray-500">কিসের জন্য টাকা নিলেন?</label>
                <input
                  type="text"
                  value={paymentForm.description}
                  onChange={(e) => setPaymentForm({ ...paymentForm, description: e.target.value })}
                  className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="যেমন: নগদ পরিশোধ"
                  autoFocus
                />

                <label className="text-xs font-semibold text-gray-500">কত টাকা?</label>
                <input
                  type="number"
                  value={paymentForm.amount}
                  onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                  className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="যেমন: ৫০০০"
                />

                {paymentFormError && <p className="text-sm text-red-600 mt-3">{paymentFormError}</p>}

                <button
                  onClick={submitPaymentForm}
                  disabled={paymentSubmitting}
                  className="w-full mt-5 bg-emerald-600 text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-emerald-700 disabled:opacity-60"
                >
                  {paymentSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                  {paymentSubmitting ? 'সেভ হচ্ছে...' : paymentForm.editingId ? 'আপডেট করুন' : 'সেভ করুন'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ম্যানুয়ালি উপস্থিতি — তারিখ + শিফট সিলেক্ট — ফুল পেজ
  // অর্ডার ম্যানেজমেন্ট — এডমিন অনুমোদনের পেজ (পেন্ডিং এডিট + ডিলিট)
  if (showOrderApprovalsPage) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">অনুমোদনের অপেক্ষায়</h1>
          </div>
          <div className="p-4">
            {orderApprovalsLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 size={28} className="animate-spin text-[#034B58]" />
              </div>
            ) : (
              <>
                <h3 className="text-sm font-bold text-gray-700 mb-3">এডিটের অনুরোধ ({orderPendingEdits.length})</h3>
                {orderPendingEdits.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-4">কোনো এডিট অনুরোধ নেই</p>
                ) : (
                  <div className="flex flex-col gap-3 mb-6">
                    {orderPendingEdits.map((edit) => (
                      <div key={edit.id} className="bg-white rounded-2xl shadow-md p-4 border-l-4 border-amber-500">
                        <p className="text-xs text-gray-500 mb-2">{edit.submitted_by} এডিট করতে চেয়েছেন</p>
                        <p className="text-xs font-semibold text-gray-500 mb-1">আগে:</p>
                        <p className="text-sm text-gray-500 bg-gray-50 rounded-lg p-2 mb-2 whitespace-pre-wrap">{edit.original_raw_text}</p>
                        <p className="text-xs font-semibold text-gray-500 mb-1">প্রস্তাবিত:</p>
                        <p className="text-sm text-gray-900 bg-amber-50 rounded-lg p-2 mb-3 whitespace-pre-wrap">{edit.proposed_raw_text}</p>
                        <div className="flex gap-2">
                          <button onClick={() => approveOrderEdit(edit.id)} className="flex-1 bg-emerald-600 text-white rounded-full py-2 text-sm font-semibold active:bg-emerald-700">
                            অনুমোদন করুন
                          </button>
                          <button onClick={() => declineOrderEdit(edit.id)} className="flex-1 bg-red-100 text-red-700 rounded-full py-2 text-sm font-semibold active:bg-red-200">
                            বাতিল করুন
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <h3 className="text-sm font-bold text-gray-700 mb-3">ডিলিটের অনুরোধ ({orderPendingDeletes.length})</h3>
                {orderPendingDeletes.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-4">কোনো ডিলিট অনুরোধ নেই</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {orderPendingDeletes.map((del) => (
                      <div key={del.id} className="bg-white rounded-2xl shadow-md p-4 border-l-4 border-red-500">
                        <p className="text-xs text-gray-500 mb-2">{del.submitted_by} মুছে ফেলতে চেয়েছেন</p>
                        <p className="text-sm text-gray-900 bg-red-50 rounded-lg p-2 mb-3 whitespace-pre-wrap">{del.raw_text}</p>
                        {del.reason && (
                          <p className="text-sm text-gray-800 bg-amber-50 rounded-lg p-2 mb-3 whitespace-pre-wrap">
                            <span className="text-xs font-bold text-amber-700 uppercase block mb-0.5">কারণ</span>
                            {del.reason}
                          </p>
                        )}
                        <div className="flex gap-2">
                          <button onClick={() => approveOrderDelete(del.id)} className="flex-1 bg-emerald-600 text-white rounded-full py-2 text-sm font-semibold active:bg-emerald-700">
                            অনুমোদন করুন
                          </button>
                          <button onClick={() => declineOrderDelete(del.id)} className="flex-1 bg-red-100 text-red-700 rounded-full py-2 text-sm font-semibold active:bg-red-200">
                            বাতিল করুন
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // সেল সামারি — মোট অর্ডার, মোট টাকা, পেইজ ও মডারেটর অনুযায়ী ভাঙা — ফুল পেজ
  if (showSaleSummaryPage) {
    const periodLabels = {
      yesterday: 'গতকাল',
      running_week: 'চলতি সপ্তাহ',
      last_week: 'গত সপ্তাহ',
      running_month: 'চলতি মাস',
      custom: 'কাস্টম'
    };
    const formatSaleSummaryDate = (dateStr) => {
      const [y, m, d] = dateStr.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('bn-BD', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    };
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">সেল সামারি</h1>
          </div>

          <div className="p-4">
            {/* একদিন করে সামনে/পিছনে — ডিফল্টভাবে আজকে সিলেক্ট থাকে */}
            <div className="flex items-center justify-between bg-white rounded-2xl shadow-md p-3 mb-3">
              <button onClick={() => shiftSaleSummaryDate(-1)} className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center">
                <ChevronRight size={18} className="rotate-180 text-gray-700" />
              </button>
              <p className="text-sm font-semibold text-gray-900">{formatSaleSummaryDate(saleSummaryDate)}</p>
              <button onClick={() => shiftSaleSummaryDate(1)} className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center">
                <ChevronRight size={18} className="text-gray-700" />
              </button>
            </div>

            <div className="flex gap-2 overflow-x-auto pb-1 mb-3">
              {Object.entries(periodLabels).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => key === 'custom' ? setSaleSummaryPeriod('custom') : switchSaleSummaryPeriod(key)}
                  className={`shrink-0 px-4 py-2 rounded-full text-sm font-semibold ${
                    saleSummaryPeriod === key ? 'bg-[#075B68] text-white' : 'bg-white text-gray-600 border border-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {saleSummaryPeriod === 'custom' && (
              <div className="bg-white rounded-2xl shadow-md p-4 mb-4">
                <div className="flex gap-2 mb-3">
                  <div className="flex-1">
                    <label className="text-xs font-semibold text-gray-500">শুরুর তারিখ</label>
                    <input
                      type="date"
                      value={saleSummaryCustomFrom}
                      onChange={(e) => setSaleSummaryCustomFrom(e.target.value)}
                      className="w-full mt-1 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#034B58]"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs font-semibold text-gray-500">শেষ তারিখ</label>
                    <input
                      type="date"
                      value={saleSummaryCustomTo}
                      onChange={(e) => setSaleSummaryCustomTo(e.target.value)}
                      className="w-full mt-1 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#034B58]"
                    />
                  </div>
                </div>
                <button
                  onClick={applySaleSummaryCustomRange}
                  className="w-full bg-[#075B68] text-white rounded-full py-2.5 text-sm font-semibold active:bg-[#034B58]"
                >
                  দেখুন
                </button>
              </div>
            )}

            {saleSummaryLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 size={28} className="animate-spin text-[#034B58]" />
              </div>
            ) : !saleSummaryData ? (
              <p className="text-sm text-gray-500 text-center py-8">ডেটা পাওয়া যায়নি</p>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-white rounded-2xl shadow-md p-4 border-l-4 border-blue-500">
                    <p className="text-2xl font-bold text-gray-900">{saleSummaryData.total_orders}</p>
                    <p className="text-xs text-gray-500 mt-0.5">মোট অর্ডার</p>
                  </div>
                  <div className="bg-white rounded-2xl shadow-md p-4 border-l-4 border-emerald-500">
                    <p className="text-2xl font-bold text-gray-900">৳{saleSummaryData.total_amount.toFixed(2)}</p>
                    <p className="text-xs text-gray-500 mt-0.5">মোট টাকা</p>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-bold text-gray-700 mb-2">পেইজ অনুযায়ী</h3>
                  {saleSummaryData.by_page.length === 0 ? (
                    <p className="text-sm text-gray-400">এই সময়ে কোনো অর্ডার নেই</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {saleSummaryData.by_page.map((p, i) => (
                        <div key={i} className="bg-white rounded-2xl shadow-sm p-3.5 flex items-center justify-between">
                          <p className="text-sm text-gray-800">{p.page_name}</p>
                          <div className="text-right">
                            <p className="text-sm font-bold text-gray-900">{p.count}টা অর্ডার</p>
                            <p className="text-xs text-gray-500">৳{p.amount.toFixed(2)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="text-sm font-bold text-gray-700 mb-2">মডারেটর অনুযায়ী</h3>
                  {saleSummaryData.by_moderator.length === 0 ? (
                    <p className="text-sm text-gray-400">এই সময়ে কোনো অর্ডার নেই</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {saleSummaryData.by_moderator.map((m, i) => (
                        <div key={i} className="bg-white rounded-2xl shadow-sm p-3.5 flex items-center justify-between">
                          <p className="text-sm text-gray-800">{m.moderator}</p>
                          <div className="text-right">
                            <p className="text-sm font-bold text-gray-900">{m.count}টা অর্ডার</p>
                            <p className="text-xs text-gray-500">৳{m.amount.toFixed(2)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // অর্ডার ম্যানেজমেন্ট — মূল অ্যাপের থিমে (লাল/সাদা) — গ্রুপ সিলেকশন + লিস্ট
  if (showOrderManagementPage) {
    const groupMeta = {
      emergency: { label: 'Emergency Order Group', icon: <Bell size={22} />, color: '#ef4444', bg: '#fee2e2', border: 'border-red-500' },
      pending: { label: 'Pending Group Order', icon: <Clock size={22} />, color: '#d97706', bg: '#fef3c7', border: 'border-amber-500' },
      all_order: { label: 'All Order Group', icon: <Package size={22} />, color: '#2563eb', bg: '#dbeafe', border: 'border-blue-500' }
    };

    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-24 relative">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button
              onClick={() => window.history.back()}
              className="text-white shrink-0"
            >
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold flex-1">
              {orderMgmtView === 'groups' ? 'অর্ডার ম্যানেজমেন্ট' : groupMeta[orderGroupTab].label}
            </h1>
            {currentUser?.role === 'admin' && (
              <button onClick={openOrderApprovalsPage} className="relative text-white/90 bg-white/10 rounded-full px-3 py-1.5 text-xs font-semibold">
                অনুমোদন
                {(orderPendingEdits.length + orderPendingDeletes.length) > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-amber-400 text-[#075B68] text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                    !
                  </span>
                )}
              </button>
            )}
          </div>

          {/* ==== গ্রুপ সিলেকশন ভিউ ==== */}
          {orderMgmtView === 'groups' && (
            <div className="p-4 flex flex-col gap-3">
              {['emergency', 'pending', 'all_order'].map((group) => {
                const meta = groupMeta[group];
                return (
                  <button
                    key={group}
                    onClick={() => {
                      if (currentUser?.role === 'moderator' && group !== 'all_order') {
                        alert('এই গ্রুপের অ্যাক্সেস আপনার নেই');
                        return;
                      }
                      openOrderGroup(group);
                    }}
                    className={`text-left bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 ${meta.border} active:opacity-80`}
                  >
                    <div className="w-14 h-14 rounded-full flex items-center justify-center shrink-0" style={{ backgroundColor: meta.bg, color: meta.color }}>
                      {meta.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-gray-900 font-bold text-base truncate">{meta.label}</p>
                      <p className="text-gray-400 text-xs mt-0.5">
                        {orderLastUpdated ? orderLastUpdated.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'}
                      </p>
                    </div>
                    <span
                      className="text-sm font-bold px-3 py-1.5 rounded-full shrink-0 text-white"
                      style={{ backgroundColor: meta.color }}
                    >
                      {group === 'all_order' ? allOrderTotal || orderCounts.all_order || 0 : orderCounts[group] || 0}
                    </span>
                    <ChevronRight size={18} className="text-gray-300 shrink-0" />
                  </button>
                );
              })}
            </div>
          )}

          {/* ==== লিস্ট ভিউ (অর্ডার ফিড) ==== */}
          {orderMgmtView === 'list' && (
            <div className="p-4">
              {(orderGroupTab === 'all_order' || orderGroupTab === 'pending') && (
                <div className="relative mb-3">
                  <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    value={orderSearchQuery}
                    onChange={(e) => setOrderSearchQuery(e.target.value)}
                    placeholder="ফোন নাম্বার, অর্ডার নাম্বার বা পার্সেল আইডি দিয়ে খুঁজুন"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#034B58] bg-white"
                  />
                </div>
              )}
              {orderActionError && (
                <p className="text-sm text-red-600 bg-red-50 rounded-xl p-3 mb-3">{orderActionError}</p>
              )}
              {orderEntriesLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 size={28} className="animate-spin text-[#034B58]" />
                </div>
              ) : orderEntries.filter(matchesOrderSearch).length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">
                  {orderSearchQuery ? 'কোনো অর্ডার মিলেনি' : 'এখানে কোনো অর্ডার নেই'}
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  {orderEntries.filter(matchesOrderSearch).map((entry) => (
                    <div key={entry.id} className="bg-white rounded-2xl shadow-md overflow-hidden">
                      {entry.image_urls && entry.image_urls.length > 0 && (
                        <div className="relative flex overflow-x-auto bg-gray-100">
                          {entry.image_urls.map((url, i) => (
                            <img
                              key={i}
                              src={url}
                              alt=""
                              onClick={() => setViewingFullImage(url)}
                              className="w-full max-h-80 object-contain shrink-0"
                            />
                          ))}
                          {entry.status !== 'sent' && (
                            <span className="absolute top-2 right-2 bg-amber-500 text-white text-[11px] font-bold px-2.5 py-1 rounded-full shadow">
                              কুরিয়ারে পাঠানো বাকি
                            </span>
                          )}
                        </div>
                      )}

                      <div className="p-4">
                        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-gray-500 text-sm">{entry.moderator}</span>
                            {entry.page_name && (
                              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                                {entry.page_name}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <div className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ${
                              entry.reacted_by_me ? 'bg-red-50 text-red-600' : 'bg-gray-50 text-gray-400'
                            }`}>
                              <button onClick={() => toggleOrderReaction(entry)} className="flex items-center">
                                <Heart size={13} fill={entry.reacted_by_me ? '#dc2626' : 'none'} />
                              </button>
                              {entry.reaction_count > 0 && (
                                <button onClick={() => setViewingReactors(entry.reactors || [])}>
                                  {entry.reaction_count}
                                </button>
                              )}
                            </div>
                            {entry.status === 'sent' ? (
                              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700">পাঠানো হয়েছে</span>
                            ) : !entry.image_urls || entry.image_urls.length === 0 ? (
                              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">কুরিয়ারে পাঠানো বাকি</span>
                            ) : null}
                          </div>
                        </div>

                        {entry.status !== 'sent' && (
                          <div className="flex items-center gap-2 mb-3 flex-wrap">
                            {orderGroupTab !== 'emergency' && (
                              <button
                                onClick={() => sendOrderToEmergency(entry)}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-red-50 text-red-700"
                              >
                                🚨 Emergency
                              </button>
                            )}
                            <button
                              onClick={() => checkOrderFraud(entry)}
                              disabled={checkingFraudId === entry.id}
                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-sky-50 text-sky-700 disabled:opacity-60"
                            >
                              {checkingFraudId === entry.id ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} Fraud
                            </button>
                            <button
                              onClick={() => openDeleteOrder(entry)}
                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full bg-gray-100 text-gray-600"
                            >
                              <Trash2 size={12} /> Delete
                            </button>
                          </div>
                        )}

                        {/* একবার ফ্রড চেক করা হলে ফলাফলটা কার্ডেই স্থায়ীভাবে দেখাবে */}
                        {entry.fraud_check_result && (
                          <button
                            onClick={() => setFraudResult({ phone: entry.customer_phone, ...entry.fraud_check_result })}
                            className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 rounded-full px-3 py-1.5 mb-3 flex-wrap"
                          >
                            🚚 মোট {entry.fraud_check_result.total_parcels ?? '—'} · ডেলিভার {entry.fraud_check_result.total_delivered ?? '—'} · ক্যান্সেল {entry.fraud_check_result.total_cancelled ?? '—'} · সফলতা {computeSuccessRatio(entry.fraud_check_result)}%
                            {entry.fraud_check_result.total_fraud_reports?.length > 0 && (
                              <span className="text-red-600 font-semibold">· ⚠️ {entry.fraud_check_result.total_fraud_reports.length}টা ফ্রড রিপোর্ট</span>
                            )}
                          </button>
                        )}

                        {entry.order_number != null && (
                          <p className="text-sm font-bold text-[#075B68] mb-1">অর্ডার নাম্বার {entry.order_number}</p>
                        )}
                        <p className="text-gray-900 text-sm whitespace-pre-wrap leading-relaxed mb-3">{entry.raw_text}</p>

                        {entry.status === 'sent' ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => openTracking(entry)}
                              className="flex-1 bg-[#075B68] text-amber-300 rounded-full py-3 text-sm font-bold flex items-center justify-center gap-2 active:bg-[#034B58]"
                            >
                              ✅ পার্সেল আইডি: {entry.consignment_id} · ৳{entry.amount ?? '—'}
                            </button>
                            {orderGroupTab !== 'all_order' && (
                              <button
                                onClick={() => openDeleteOrder(entry)}
                                className="w-11 h-11 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center shrink-0"
                              >
                                <Trash2 size={16} />
                              </button>
                            )}
                          </div>
                        ) : orderGroupTab !== 'all_order' ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => sendOrderToCourier(entry)}
                              disabled={sendingCourierId === entry.id}
                              className="flex-1 bg-[#075B68] text-white rounded-full py-3 text-sm font-bold flex items-center justify-center gap-2 active:bg-[#034B58] disabled:opacity-60"
                            >
                              {sendingCourierId === entry.id ? <Loader2 size={16} className="animate-spin" /> : '📦'}
                              {sendingCourierId === entry.id ? 'পাঠানো হচ্ছে...' : 'Send to Courier'}
                            </button>
                            <button
                              onClick={() => openEditOrder(entry)}
                              className="w-11 h-11 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center shrink-0"
                            >
                              <Pencil size={16} />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="flex-1 bg-amber-50 text-amber-700 rounded-full py-3 text-sm font-semibold flex items-center justify-center gap-2">
                              ⏳ Waiting for courier send
                            </span>
                            <button
                              onClick={() => openEditOrder(entry)}
                              className="w-11 h-11 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center shrink-0"
                            >
                              <Pencil size={16} />
                            </button>
                          </div>
                        )}

                        <p className="text-xs text-gray-400 text-center mt-3">
                          {new Date(entry.created_at).toLocaleString('bn-BD', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  ))}

                  {orderGroupTab === 'all_order' && allOrderOffset < allOrderTotal && (
                    <button
                      onClick={() => fetchAllOrderPage(allOrderOffset)}
                      disabled={allOrderLoadingMore}
                      className="bg-white text-gray-700 border border-gray-200 rounded-full py-3 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                    >
                      {allOrderLoadingMore ? <Loader2 size={16} className="animate-spin" /> : null}
                      {allOrderLoadingMore ? 'লোড হচ্ছে...' : `আরও দেখুন (${allOrderTotal - allOrderOffset} বাকি)`}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {orderMgmtView === 'list' && (
            <button
              onClick={openComposeOrder}
              className="fixed bottom-24 right-6 w-14 h-14 rounded-full bg-[#075B68] text-white shadow-lg flex items-center justify-center active:bg-[#034B58] z-20"
            >
              <PlusCircle size={26} />
            </button>
          )}

          {/* নতুন অর্ডার পোস্ট করুন */}
          {showComposeOrder && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">নতুন অর্ডার পোস্ট করুন</h2>
                  <button onClick={() => setShowComposeOrder(false)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>

                <label className="text-xs font-semibold text-gray-500">কোন পেইজ?</label>
                <select
                  value={composeOrderPageId || ''}
                  onChange={(e) => setComposeOrderPageId(e.target.value ? parseInt(e.target.value) : null)}
                  className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                >
                  <option value="">— বাছাই করুন —</option>
                  {orderPages.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>

                <label className="text-xs font-semibold text-gray-500">অর্ডারের তথ্য (কাস্টমারের নাম/ফোন/ঠিকানা/প্রোডাক্ট — যেভাবে আছে সেভাবে পেস্ট করুন)</label>
                <textarea
                  value={composeOrderText}
                  onChange={(e) => setComposeOrderText(e.target.value)}
                  rows={6}
                  className="w-full mt-1 mb-3 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="যেমন: রহিম, ০১৭xxxxxxxx, মিরপুর ঢাকা, ২টা আবায়া, দাম ২৫০০ টাকা"
                />

                <input type="file" accept="image/*" multiple onChange={handleComposeOrderImageChange} className="text-sm mb-3" />

                {composeOrderImages.length > 0 && (
                  <div className="flex gap-2 mb-3 overflow-x-auto">
                    {composeOrderImages.map((img, i) => (
                      <div key={i} className="relative shrink-0">
                        <img src={img} alt="" className="w-16 h-16 rounded-lg object-cover" />
                        <button
                          onClick={() => removeComposeOrderImage(i)}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white flex items-center justify-center"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {composeOrderError && <p className="text-sm text-red-600 mb-3">{composeOrderError}</p>}

                <button
                  onClick={() => submitComposeOrder(false)}
                  disabled={composeOrderSubmitting}
                  className="w-full bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                >
                  {composeOrderSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                  {composeOrderSubmitting ? 'পোস্ট হচ্ছে...' : 'পোস্ট করুন'}
                </button>
              </div>
            </div>
          )}

          {/* ডুপ্লিকেট অর্ডার সতর্কতা — মাঝখানে পপআপ */}
          {duplicateOrderInfo && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-6">
              <div className="w-full sm:max-w-sm bg-white rounded-3xl p-6">
                <div className="flex items-center gap-2 mb-4">
                  <ShieldCheck size={22} className="text-amber-600" />
                  <h2 className="text-lg font-bold text-gray-900">এই নাম্বারে আগেই একটা অর্ডার আছে</h2>
                </div>
                <div className="bg-amber-50 rounded-2xl p-4 mb-5 space-y-1.5">
                  <p className="text-sm text-gray-800">
                    <span className="text-gray-500">অর্ডার নাম্বার:</span>{' '}
                    <span className="font-bold">{duplicateOrderInfo.order_number ?? duplicateOrderInfo.id}</span>
                  </p>
                  <p className="text-sm text-gray-800">
                    <span className="text-gray-500">বর্তমান স্ট্যাটাস:</span>{' '}
                    <span className="font-bold">
                      {duplicateOrderInfo.status === 'sent' ? 'কুরিয়ারে পাঠানো হয়েছে' : 'পেন্ডিং-এ আছে'}
                    </span>
                  </p>
                  <p className="text-sm text-gray-800">
                    <span className="text-gray-500">তারিখ:</span>{' '}
                    {new Date(duplicateOrderInfo.created_at).toLocaleString('bn-BD')}
                  </p>
                </div>
                <p className="text-sm text-gray-700 mb-5">আপনি কি তারপরও নতুন করে পোস্ট করতে চাচ্ছেন?</p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setDuplicateOrderInfo(null)}
                    className="flex-1 bg-gray-100 text-gray-700 rounded-full py-3 text-sm font-semibold"
                  >
                    না
                  </button>
                  <button
                    onClick={() => { setDuplicateOrderInfo(null); submitComposeOrder(true); }}
                    disabled={composeOrderSubmitting}
                    className="flex-1 bg-[#075B68] text-white rounded-full py-3 text-sm font-semibold active:bg-[#034B58] disabled:opacity-60"
                  >
                    হ্যাঁ
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* কে রিয়েক্ট দিয়েছে */}
          {viewingReactors && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-6" onClick={() => setViewingReactors(null)}>
              <div className="w-full sm:max-w-sm bg-white rounded-3xl p-6 max-h-[70vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                    <Heart size={18} className="text-red-500" fill="#ef4444" /> রিয়েক্ট দিয়েছেন
                  </h2>
                  <button onClick={() => setViewingReactors(null)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>
                <div className="flex flex-col gap-3">
                  {viewingReactors.map((r, i) => (
                    <div key={i} className="flex items-center gap-3">
                      {r.photo_url ? (
                        <img src={r.photo_url} alt="" className="w-9 h-9 rounded-full object-cover" />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-red-100 text-red-700 flex items-center justify-center text-sm font-bold">
                          {r.name?.[0] || '?'}
                        </div>
                      )}
                      <p className="text-sm font-medium text-gray-800">{r.name}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* অর্ডার এডিট করুন */}
          {editingOrderEntry && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">অর্ডার এডিট করুন</h2>
                  <button onClick={() => setEditingOrderEntry(null)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>
                <textarea
                  value={editOrderText}
                  onChange={(e) => setEditOrderText(e.target.value)}
                  rows={6}
                  className="w-full mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                />
                {currentUser?.role !== 'admin' && (
                  <p className="text-xs text-amber-600 mb-3">এই পরিবর্তন এডমিনের অনুমোদনের পর কার্যকর হবে</p>
                )}
                <button
                  onClick={submitEditOrder}
                  disabled={savingOrderEdit}
                  className="w-full bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                >
                  {savingOrderEdit ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                  {savingOrderEdit ? 'সেভ হচ্ছে...' : 'সেভ করুন'}
                </button>
              </div>
            </div>
          )}

          {/* অর্ডার ডিলিট করুন */}
          {deletingOrderEntry && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">
                    {currentUser?.role === 'admin' ? 'অর্ডার ডিলিট করুন' : 'কেন ডিলিট করতে চাচ্ছেন?'}
                  </h2>
                  <button onClick={() => setDeletingOrderEntry(null)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>
                {currentUser?.role === 'admin' && deletingOrderEntry.status !== 'sent' ? (
                  <>
                    <label className="text-xs font-semibold text-gray-500">পাসওয়ার্ড দিন</label>
                    <input
                      type="password"
                      value={deleteOrderPassword}
                      onChange={(e) => setDeleteOrderPassword(e.target.value)}
                      className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                      placeholder="পাসওয়ার্ড"
                      autoFocus
                    />
                  </>
                ) : currentUser?.role === 'admin' ? (
                  <p className="text-sm text-gray-600 mb-4">এই অর্ডার ইতিমধ্যে কুরিয়ারে পাঠানো হয়ে গেছে — শুধু পোস্টটা মুছে ফেলা হবে, পাসওয়ার্ড লাগবে না।</p>
                ) : (
                  <>
                    <p className="text-sm text-gray-600 mb-3">এই ডিলিট অনুরোধ এডমিনের অনুমোদনের জন্য পাঠানো হবে, কারণসহ।</p>
                    <textarea
                      value={deleteOrderReason}
                      onChange={(e) => setDeleteOrderReason(e.target.value)}
                      rows={3}
                      className="w-full mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                      placeholder="যেমন: কাস্টমার অর্ডার বাতিল করেছে, ভুল করে দুইবার পোস্ট হয়ে গেছে..."
                      autoFocus
                    />
                  </>
                )}
                {deleteOrderError && <p className="text-sm text-red-600 mb-3">{deleteOrderError}</p>}
                <button
                  onClick={submitDeleteOrder}
                  disabled={deletingOrderSubmitting}
                  className="w-full bg-red-700 text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-red-800 disabled:opacity-60"
                >
                  {deletingOrderSubmitting ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                  {deletingOrderSubmitting ? 'হচ্ছে...' : currentUser?.role === 'admin' ? 'ডিলিট করুন' : 'অনুরোধ পাঠান'}
                </button>
              </div>
            </div>
          )}

          {/* ফ্রড চেক রেজাল্ট */}
          {fraudResult && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-6" onClick={() => setFraudResult(null)}>
              <div className="w-full sm:max-w-sm bg-white rounded-3xl p-6 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                    <ShieldCheck size={18} className="text-sky-600" /> Fraud Check
                  </h2>
                  <button onClick={() => setFraudResult(null)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>

                <p className="text-sm text-gray-500 flex items-center gap-1.5 mb-3">
                  <Phone size={14} /> {fraudResult.phone}
                </p>

                <div className="bg-amber-50 rounded-2xl p-4 mb-3">
                  <p className="text-sm font-semibold text-amber-800 mb-1">Steadfast (অফিসিয়াল)</p>
                  <p className="text-sm text-gray-700">
                    মোট {fraudResult.total_parcels ?? '—'} · ডেলিভার {fraudResult.total_delivered ?? '—'} · ক্যান্সেল {fraudResult.total_cancelled ?? '—'} · সফলতা {computeSuccessRatio(fraudResult)}%
                  </p>
                </div>

                {fraudResult.total_fraud_reports?.length > 0 ? (
                  <div>
                    <p className="text-sm font-semibold text-red-700 mb-2">⚠️ {fraudResult.total_fraud_reports.length}টা ফ্রড রিপোর্ট পাওয়া গেছে</p>
                    <div className="flex flex-col gap-2">
                      {fraudResult.total_fraud_reports.map((report, i) => (
                        <div key={i} className="bg-red-50 rounded-xl p-3">
                          <p className="text-sm font-semibold text-gray-900">{report.name}</p>
                          <p className="text-xs text-gray-500 mb-1">{report.phone}</p>
                          <p className="text-xs text-gray-700 whitespace-pre-wrap">{report.details}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-emerald-700 bg-emerald-50 rounded-xl p-3">কোনো ফ্রড রিপোর্ট পাওয়া যায়নি</p>
                )}
              </div>
            </div>
          )}

          {/* কুরিয়ারে পাঠানো সফল — কনফার্মেশন */}
          {courierSuccessResult && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-6">
              <div className="w-full sm:max-w-sm bg-white rounded-3xl p-6 max-h-[85vh] overflow-y-auto">
                <div className="flex items-center gap-2 mb-5">
                  <CheckCircle2 size={22} className="text-emerald-600" />
                  <h2 className="text-lg font-bold text-gray-900">কুরিয়ারে পাঠানো হয়েছে</h2>
                </div>

                {courierSuccessResult.entry.image_urls && courierSuccessResult.entry.image_urls.length > 0 && (
                  <img
                    src={courierSuccessResult.entry.image_urls[0]}
                    alt=""
                    className="w-full max-h-56 object-contain bg-gray-100 rounded-2xl mb-4"
                  />
                )}

                <div className="space-y-3 mb-5">
                  <div>
                    <p className="text-xs font-semibold text-gray-400 uppercase">Order #</p>
                    <p className="text-xl font-bold text-gray-900">{courierSuccessResult.entry.order_number ?? courierSuccessResult.entry.id}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-400 uppercase">Parcel ID</p>
                    <p className="text-xl font-bold text-gray-900">{courierSuccessResult.consignment_id}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-400 uppercase">Total Bill</p>
                    <p className="text-xl font-bold text-[#075B68]">৳{courierSuccessResult.entry.amount ?? '—'}</p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 print:hidden">
                  <button
                    onClick={() => {
                      const entry = courierSuccessResult.entry;
                      setCourierSuccessResult(null);
                      openDeleteOrder(entry);
                    }}
                    className="bg-red-50 text-red-700 rounded-full py-3 text-sm font-semibold"
                  >
                    Delete
                  </button>
                  <button
                    onClick={printCourierSticker}
                    className="bg-amber-100 text-amber-800 rounded-full py-3 text-sm font-semibold"
                  >
                    Print
                  </button>
                  <button
                    onClick={() => setCourierSuccessResult(null)}
                    className="bg-[#075B68] text-white rounded-full py-3 text-sm font-semibold active:bg-[#034B58]"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* কুরিয়ারে পাঠানো ব্যর্থ — কেন ব্যর্থ হলো সেটা স্পষ্টভাবে দেখানো হচ্ছে */}
          {courierErrorResult && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
                <div className="flex items-center gap-2 mb-4">
                  <X size={22} className="text-red-600 bg-red-50 rounded-full p-0.5" />
                  <h2 className="text-lg font-bold text-gray-900">কুরিয়ারে পাঠানো যায়নি</h2>
                </div>
                <p className="text-sm text-gray-700 bg-red-50 rounded-2xl p-4 mb-5">{courierErrorResult.message}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => { const e = courierErrorResult.entry; setCourierErrorResult(null); openEditOrder(e); }}
                    className="flex-1 bg-amber-100 text-amber-800 rounded-full py-3 text-sm font-semibold"
                  >
                    এডিট করুন
                  </button>
                  <button
                    onClick={() => setCourierErrorResult(null)}
                    className="flex-1 bg-[#075B68] text-white rounded-full py-3 text-sm font-semibold active:bg-[#034B58]"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* সম্পূর্ণ ট্র্যাকিং — পার্সেল আইডিতে ক্লিক করলে */}
          {(trackingResult || trackingLoading) && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-6" onClick={() => { setTrackingResult(null); setTrackingLoading(false); }}>
              <div className="w-full sm:max-w-sm bg-white rounded-3xl p-6 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-lg font-bold text-gray-900">ডেলিভারি ট্র্যাকিং</h2>
                  <button onClick={() => { setTrackingResult(null); setTrackingLoading(false); }} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>
                {trackingResult?.entry?.consignment_id && (
                  <p className="text-xs text-gray-400 mb-4">Parcel ID: {trackingResult.entry.consignment_id}</p>
                )}

                {trackingLoading ? (
                  <div className="flex flex-col items-center justify-center py-10 gap-3">
                    <Loader2 size={28} className="animate-spin text-[#034B58]" />
                    <p className="text-sm text-gray-500">ট্র্যাকিং আনা হচ্ছে...</p>
                  </div>
                ) : trackingResult?.error ? (
                  <p className="text-sm text-red-600 bg-red-50 rounded-2xl p-4">{trackingError}</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {/* স্ট্যাটাস — থিমের কালারে */}
                    <div className="bg-[#075B68] text-amber-300 rounded-2xl py-3.5 text-center text-sm font-bold">
                      {trackingResult?.status || 'স্ট্যাটাস পাওয়া যায়নি'}
                    </div>

                    {/* কাস্টমারের তথ্য */}
                    <div className="bg-gray-50 rounded-2xl p-4">
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">কাস্টমার</p>
                      {(() => {
                        const info = trackingResult?.client_info || {};
                        const entries = Object.entries(info);
                        const phoneEntry = entries.find(([, v]) => /01[3-9]\d{8}/.test(v || ''));
                        const otherEntries = entries.filter((e) => e !== phoneEntry);
                        return (
                          <>
                            {otherEntries.map(([label, value], i) => (
                              <p key={i} className="text-sm text-gray-800 leading-relaxed">{value}</p>
                            ))}
                            {phoneEntry && (
                              <div className="flex items-center justify-between mt-2">
                                <span className="text-sm text-gray-800">{phoneEntry[1]}</span>
                                <a
                                  href={`tel:${phoneEntry[1]}`}
                                  className="flex items-center gap-1 text-xs font-semibold bg-[#075B68] text-white rounded-full px-3 py-1.5"
                                >
                                  <Phone size={12} /> Call
                                </a>
                              </div>
                            )}
                            <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-200">
                              <span className="text-xs font-semibold text-gray-400 uppercase">COD</span>
                              <span className="text-sm font-bold text-gray-900">৳{trackingResult?.entry?.amount ?? '—'}</span>
                            </div>
                          </>
                        );
                      })()}
                    </div>

                    {/* রাইডার */}
                    <div className="bg-gray-50 rounded-2xl p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">রাইডার</p>
                          <p className="text-sm font-semibold text-gray-900">{trackingResult?.rider_name || 'Unassigned'}</p>
                        </div>
                        {trackingResult?.rider_phone && (
                          <a
                            href={`tel:${trackingResult.rider_phone}`}
                            className="flex items-center gap-1 text-xs font-semibold bg-[#075B68] text-white rounded-full px-3 py-1.5"
                          >
                            <Phone size={12} /> Call
                          </a>
                        )}
                      </div>
                    </div>

                    {/* ট্র্যাকিং আপডেট */}
                    {trackingResult?.timeline?.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">ট্র্যাকিং আপডেট</p>
                        <div className="flex flex-col gap-2">
                          {[...trackingResult.timeline].reverse().map((step, i) => (
                            <div key={i} className="bg-gray-50 rounded-xl p-3 text-sm text-gray-700 leading-relaxed">
                              {step}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* বাকি অ্যাপের মতোই নিচের নেভিগেশন বার — মডারেটরের জন্য শুধু লগআউট, বাকি অ্যাপে এক্সেস নেই */}
          <div className="fixed bottom-0 w-full sm:max-w-sm bg-white border-t border-gray-200 flex justify-around py-2.5 z-10">
            {currentUser?.role === 'moderator' ? (
              <>
                <div className="relative flex flex-col items-center gap-1 px-4 text-[#075B68]">
                  <Package size={24} />
                  <span className="text-xs font-medium">প্রোডাকশন</span>
                </div>
                <button onClick={onLogout} className="relative flex flex-col items-center gap-1 px-4 text-gray-400">
                  <LogOut size={24} />
                  <span className="text-xs font-medium">লগআউট</span>
                </button>
              </>
            ) : (
              navItems.map((n, i) => (
                <button
                  key={i}
                  onClick={
                    n.label === 'হোম' ? () => setShowOrderManagementPage(false) :
                    n.label === 'অ্যালার্ট' ? openNotifications :
                    n.label === 'প্রোফাইল' ? () => setShowProfileMenu(true) :
                    n.label === 'প্রোডাকশন' ? undefined :
                    undefined
                  }
                  className={`relative flex flex-col items-center gap-1 px-4 ${n.label === 'প্রোডাকশন' ? 'text-[#075B68]' : 'text-gray-400'}`}
                >
                  {n.icon}
                  {n.label === 'অ্যালার্ট' && unreadCount > 0 && (
                    <span className="absolute -top-0.5 right-2 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                  <span className="text-xs font-medium">{n.label}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }


  // অর্ডার ম্যানেজমেন্ট — পেইজের ক্রেডেনশিয়াল ফর্ম — ফুল পেজ
  if (selectedOrderPage) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">{selectedOrderPage.name}</h1>
          </div>

          <div className="p-4">
            <p className="text-xs font-bold text-gray-500 uppercase mb-2">কুরিয়ার (Steadfast)</p>
            <div className="bg-white rounded-2xl shadow-md p-4 mb-4">
              <label className="text-xs font-semibold text-gray-500">
                API Key {isOrderCredSet('courier', 'steadfast', 'api_key') && <span className="text-emerald-600">(সেট করা আছে ✓)</span>}
              </label>
              <input
                type="text"
                value={orderCredForm.steadfast_api_key}
                onChange={(e) => setOrderCredForm({ ...orderCredForm, steadfast_api_key: e.target.value })}
                className="w-full mt-1 mb-3 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="নতুন API Key (বদলাতে না চাইলে ফাঁকা রাখুন)"
              />
              <label className="text-xs font-semibold text-gray-500">
                Secret Key {isOrderCredSet('courier', 'steadfast', 'secret_key') && <span className="text-emerald-600">(সেট করা আছে ✓)</span>}
              </label>
              <input
                type="text"
                value={orderCredForm.steadfast_secret_key}
                onChange={(e) => setOrderCredForm({ ...orderCredForm, steadfast_secret_key: e.target.value })}
                className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="নতুন Secret Key (বদলাতে না চাইলে ফাঁকা রাখুন)"
              />
            </div>

            <p className="text-xs font-bold text-gray-500 uppercase mb-2">মডারেটর লগইন — পার্সেল আইডিতে ক্লিক করে সম্পূর্ণ ট্র্যাকিং দেখার জন্য</p>
            <div className="bg-white rounded-2xl shadow-md p-4 mb-4">
              <label className="text-xs font-semibold text-gray-500">
                ইমেইল {isOrderCredSet('courier_moderator', 'steadfast', 'api_key') && <span className="text-emerald-600">(সেট করা আছে ✓)</span>}
              </label>
              <input
                type="text"
                value={orderCredForm.moderator_email}
                onChange={(e) => setOrderCredForm({ ...orderCredForm, moderator_email: e.target.value })}
                className="w-full mt-1 mb-3 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="Steadfast মডারেটর ইমেইল (বদলাতে না চাইলে ফাঁকা রাখুন)"
              />
              <label className="text-xs font-semibold text-gray-500">
                পাসওয়ার্ড {isOrderCredSet('courier_moderator', 'steadfast', 'secret_key') && <span className="text-emerald-600">(সেট করা আছে ✓)</span>}
              </label>
              <input
                type="text"
                value={orderCredForm.moderator_password}
                onChange={(e) => setOrderCredForm({ ...orderCredForm, moderator_password: e.target.value })}
                className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="Steadfast মডারেটর পাসওয়ার্ড (বদলাতে না চাইলে ফাঁকা রাখুন)"
              />
              <p className="text-[11px] text-gray-400 mt-2 leading-snug">
                এটা Steadfast-এর সাধারণ ড্যাশবোর্ড লগইন (API key না) — রাইডারের নাম/ফোন ও ট্র্যাকিং টাইমলাইন এখান থেকেই আনা হবে।
              </p>
            </div>

            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold text-gray-500 uppercase">AI (৫টা পর্যন্ত) — একটা ব্যর্থ হলে পরেরটা অটোমেটিক চেষ্টা হবে</p>
            </div>

            {aiCredList.length === 0 ? (
              <p className="text-sm text-gray-500 bg-white rounded-2xl shadow-md p-4 mb-3">এখনো কোনো AI যোগ করা হয়নি</p>
            ) : (
              <div className="flex flex-col gap-2 mb-3">
                {aiCredList.map((cred, i) => (
                  <div key={cred.id} className="bg-white rounded-2xl shadow-md p-4 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{i + 1}. {aiProviderLabel(cred.provider)}</p>
                      <p className="text-xs text-emerald-600">সেট করা আছে ✓</p>
                    </div>
                    <button onClick={() => deleteAiCred(cred.id)} className="w-8 h-8 rounded-full bg-red-50 text-red-600 flex items-center justify-center">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {aiCredList.length < 5 && !showAddAiForm && (
              <button
                onClick={() => { setShowAddAiForm(true); setNewAiProvider('gemini'); setNewAiApiKey(''); setAiCredError(''); }}
                className="w-full bg-white rounded-2xl shadow-md p-4 flex items-center justify-center gap-2 text-fuchsia-700 font-semibold text-sm mb-4"
              >
                <PlusCircle size={16} /> নতুন AI যোগ করুন
              </button>
            )}

            {showAddAiForm && (
              <div className="bg-white rounded-2xl shadow-md p-4 mb-4">
                <label className="text-xs font-semibold text-gray-500">প্রোভাইডার বাছাই করুন</label>
                <select
                  value={newAiProvider}
                  onChange={(e) => setNewAiProvider(e.target.value)}
                  className="w-full mt-1 mb-3 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                >
                  <option value="gemini">Gemini</option>
                  <option value="openai">ChatGPT (OpenAI)</option>
                  <option value="claude">Claude (Anthropic)</option>
                </select>
                <label className="text-xs font-semibold text-gray-500">API Key</label>
                <input
                  type="text"
                  value={newAiApiKey}
                  onChange={(e) => setNewAiApiKey(e.target.value)}
                  className="w-full mt-1 mb-3 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="API Key পেস্ট করুন"
                />
                {aiCredError && <p className="text-sm text-red-600 mb-3">{aiCredError}</p>}
                <div className="flex gap-2">
                  <button onClick={() => setShowAddAiForm(false)} className="flex-1 bg-gray-100 text-gray-600 rounded-full py-2.5 text-sm font-semibold">
                    বাতিল
                  </button>
                  <button
                    onClick={submitNewAiCred}
                    disabled={savingNewAi}
                    className="flex-1 bg-fuchsia-700 text-white rounded-full py-2.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {savingNewAi ? <Loader2 size={16} className="animate-spin" /> : 'যোগ করুন'}
                  </button>
                </div>
              </div>
            )}

            <p className="text-xs text-gray-400 mb-3 leading-snug">
              নিরাপত্তার জন্য আগে সেভ করা আসল Key/Secret এখানে দেখানো হয় না, শুধু "সেট করা আছে" লেখা দেখাবে। বদলাতে চাইলে নতুন মান লিখুন, নাহলে ফাঁকা রাখলে আগেরটাই থেকে যাবে।
            </p>

            {orderCredError && <p className="text-sm text-red-600 mb-3">{orderCredError}</p>}

            <button
              onClick={submitOrderCredentials}
              disabled={savingOrderCred}
              className="w-full bg-fuchsia-700 text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-fuchsia-800 disabled:opacity-60"
            >
              {savingOrderCred ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
              {savingOrderCred ? 'সেভ হচ্ছে...' : 'সেভ করুন'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // অর্ডার ম্যানেজমেন্ট — পেইজ লিস্ট — ফুল পেজ
  if (showOrderPagesPage) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">পেইজ যোগ করুন</h1>
          </div>

          <div className="p-4">
            <div className="bg-white rounded-2xl shadow-md p-4 mb-5">
              <label className="text-xs font-semibold text-gray-500">নতুন পেইজ/দোকানের নাম</label>
              <div className="flex gap-2 mt-1">
                <input
                  type="text"
                  value={newOrderPageName}
                  onChange={(e) => setNewOrderPageName(e.target.value)}
                  className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="যেমন: Maya Garments Showroom"
                />
                <button
                  onClick={submitNewOrderPage}
                  disabled={addingOrderPage}
                  className="bg-fuchsia-700 text-white rounded-xl px-4 flex items-center justify-center disabled:opacity-60"
                >
                  {addingOrderPage ? <Loader2 size={18} className="animate-spin" /> : <PlusCircle size={18} />}
                </button>
              </div>
            </div>

            <p className="text-xs font-bold text-gray-500 uppercase mb-2">বিদ্যমান পেইজ</p>
            {orderPages.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো পেইজ যোগ করা হয়নি</p>
            ) : (
              <div className="flex flex-col gap-3">
                {orderPages.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => selectOrderPage(p)}
                    className="text-left bg-white rounded-2xl shadow-md p-4 flex items-center justify-between border-l-4 border-fuchsia-500 active:opacity-80"
                  >
                    <p className="font-semibold text-gray-900 text-sm">{p.name}</p>
                    <ChevronRight size={18} className="text-gray-400 shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // আগের হিসাব যোগ করুন — টাকার পরিমাণ + দিক নির্বাচন — ফুল পেজ
  if (previousBalanceStaff) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">{previousBalanceStaff.name}</h1>
          </div>

          <div className="p-4">
            <p className="text-xs font-bold text-gray-500 uppercase mb-2">কে পাবে?</p>
            <div className="flex gap-3 mb-5">
              <button
                onClick={() => setPreviousBalanceDirection('staff_owed')}
                className={`flex-1 py-3 rounded-xl text-sm font-semibold border flex items-center justify-center gap-2 ${
                  previousBalanceDirection === 'staff_owed' ? 'bg-emerald-600 text-white border-emerald-600' : 'border-gray-200 text-gray-600 bg-white'
                }`}
              >
                {previousBalanceDirection === 'staff_owed' && <CheckCircle2 size={15} />} কারিগর পাবে
              </button>
              <button
                onClick={() => setPreviousBalanceDirection('factory_owed')}
                className={`flex-1 py-3 rounded-xl text-sm font-semibold border flex items-center justify-center gap-2 ${
                  previousBalanceDirection === 'factory_owed' ? 'bg-[#075B68] text-white border-[#075B68]' : 'border-gray-200 text-gray-600 bg-white'
                }`}
              >
                {previousBalanceDirection === 'factory_owed' && <CheckCircle2 size={15} />} আপনি পাবেন
              </button>
            </div>

            <label className="text-xs font-semibold text-gray-500">কত টাকা?</label>
            <input
              type="number"
              value={previousBalanceAmount}
              onChange={(e) => setPreviousBalanceAmount(e.target.value)}
              className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58] bg-white"
              placeholder="যেমন: ৫০০০"
            />

            <p className="text-xs text-gray-400 mt-3 leading-snug">
              "কারিগর পাবে" সিলেক্ট করলে এই টাকা তার মোট পাওনার সাথে যোগ হবে। "আপনি পাবেন" সিলেক্ট করলে তার পাওনা থেকে এই টাকা বাদ যাবে।
              এটা ক্যাশ মেমোতে "আগের হিসাবের আপডেট" হিসেবে আলাদা করে দেখানো হবে। এটা পার্টনার হিসাবের সাথে যুক্ত হবে না।
            </p>

            {previousBalanceError && <p className="text-sm text-red-600 mt-3">{previousBalanceError}</p>}

            <button
              onClick={submitPreviousBalance}
              disabled={previousBalanceSubmitting}
              className="w-full mt-5 bg-teal-700 text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-teal-800 disabled:opacity-60"
            >
              {previousBalanceSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
              {previousBalanceSubmitting ? 'সেভ হচ্ছে...' : 'সেভ করুন'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // আগের হিসাব যোগ করুন — স্টাফ লিস্ট — ফুল পেজ
  if (showPreviousBalancePage) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">আগের হিসাব যোগ করুন</h1>
          </div>
          <div className="p-4">
            {staffList.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো স্টাফ যোগ করা হয়নি</p>
            ) : (
              <div className="flex flex-col gap-3">
                {staffList.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => selectPreviousBalanceStaff(s)}
                    className="text-left bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 border-l-4 border-teal-500 active:opacity-80"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 text-sm">{s.name}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{s.designation || 'পদবি নেই'}</p>
                      {previousBalanceAdjustments[s.id] !== undefined && (
                        <p className="mt-1 text-xs font-semibold text-teal-700 bg-teal-50 rounded-lg px-2 py-0.5 inline-block">
                          হিসাব যোগ করা হয়েছে
                        </p>
                      )}
                    </div>
                    <ChevronRight size={18} className="text-gray-400 shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (manualAttendanceStaff) {
    const dateOptions = getManualDateOptions(manualAttendanceStaff);
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-24">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">{manualAttendanceStaff.name}</h1>
          </div>

          <div className="p-4">
            <p className="text-xs font-bold text-gray-500 uppercase mb-2">কোন শিফট? (দুটোই সিলেক্ট করা যাবে — পুরো দিন কাজ করলে)</p>
            <div className="flex gap-3 mb-5">
              <button
                onClick={() => toggleManualShift(1)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border flex items-center justify-center gap-2 ${manualSelectedShifts.includes(1) ? 'bg-[#075B68] text-white border-[#075B68]' : 'border-gray-200 text-gray-600 bg-white'}`}
              >
                {manualSelectedShifts.includes(1) && <CheckCircle2 size={15} />} শিফট ১
              </button>
              <button
                onClick={() => toggleManualShift(2)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border flex items-center justify-center gap-2 ${manualSelectedShifts.includes(2) ? 'bg-[#075B68] text-white border-[#075B68]' : 'border-gray-200 text-gray-600 bg-white'}`}
              >
                {manualSelectedShifts.includes(2) && <CheckCircle2 size={15} />} শিফট ২
              </button>
            </div>

            <p className="text-xs font-bold text-gray-500 uppercase mb-2">
              তারিখ (একাধিক সিলেক্ট করা যাবে — জয়েনিং তারিখ পর্যন্ত)
            </p>
            <div className="flex flex-col gap-2">
              {dateOptions.map((dateStr) => {
                const selected = manualSelectedDates.includes(dateStr);
                return (
                  <button
                    key={dateStr}
                    onClick={() => toggleManualDate(dateStr)}
                    className={`text-left rounded-xl px-4 py-2.5 flex items-center justify-between border ${
                      selected ? 'bg-emerald-50 border-emerald-500' : 'bg-white border-gray-200'
                    }`}
                  >
                    <span className="text-sm text-gray-800">{dateStr}</span>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${selected ? 'bg-emerald-600 border-emerald-600' : 'border-gray-300'}`}>
                      {selected && <CheckCircle2 size={13} className="text-white" />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {manualSelectedDates.length > 0 && manualSelectedShifts.length > 0 && (
            <div className="fixed bottom-0 w-full sm:max-w-sm bg-white border-t border-gray-200 p-3">
              <button
                onClick={submitManualAttendance}
                disabled={manualAddSubmitting}
                className="w-full bg-emerald-600 text-white rounded-full py-3 font-semibold text-sm flex items-center justify-center gap-2 active:bg-emerald-700 disabled:opacity-60"
              >
                {manualAddSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                {manualAddSubmitting ? 'যোগ হচ্ছে...' : `${manualSelectedDates.length} দিন যোগ করুন`}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ম্যানুয়ালি উপস্থিতি যুক্ত করুন — স্টাফ লিস্ট — ফুল পেজ
  if (showManualAttendancePage) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">ম্যানুয়ালি উপস্থিত যুক্ত করুন</h1>
          </div>
          <div className="p-4">
            {staffList.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো স্টাফ যোগ করা হয়নি</p>
            ) : (
              <div className="flex flex-col gap-3">
                {staffList.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => openManualAttendanceStaff(s)}
                    className="text-left bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 border-l-4 border-emerald-500 active:opacity-80"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 text-sm">{s.name}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{s.designation || 'পদবি নেই'}</p>
                      {recentManualAdds.includes(s.id) && (
                        <p className="mt-1 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-lg px-2 py-0.5 inline-block">
                          একবার যুক্ত করা হয়েছে
                        </p>
                      )}
                    </div>
                    <ChevronRight size={18} className="text-gray-400 shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // পাইকারি হিসাব — পাইকার সিলেক্ট করুন — ফুল পেজ
  if (showWholesalerAccountSelectPage) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen pb-10">
          <div className="bg-[#075B68] text-white px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
            <button onClick={() => window.history.back()} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-base font-bold">পাইকার সিলেক্ট করুন</h1>
          </div>
          <div className="p-4">
            {wholesalers.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো পাইকার যোগ করা হয়নি</p>
            ) : (
              <div className="flex flex-col gap-3">
                {wholesalers.map((w) => (
                  <div
                    key={w.id}
                    className="bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 border-l-4 border-indigo-500"
                  >
                    <button onClick={() => openWholesalerAccount(w)} className="text-left flex-1 min-w-0 active:opacity-80">
                      <p className="font-semibold text-gray-900 text-sm">{w.name}</p>
                      {w.phone && <p className="text-xs text-gray-500 mt-0.5">{w.phone}</p>}
                    </button>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => startEditWholesaler(w)} className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
                        <Pencil size={13} className="text-amber-700" />
                      </button>
                      <button onClick={() => setDeletingWholesalerId(w.id)} className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center">
                        <Trash2 size={13} className="text-red-700" />
                      </button>
                      <ChevronRight size={18} className="text-gray-400" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* পাইকার ডিলিট কনফার্মেশন */}
          {deletingWholesalerId && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-6">
              <div className="w-full sm:max-w-sm bg-white rounded-3xl p-6">
                <h2 className="text-lg font-bold text-gray-900 mb-2">পাইকার মুছে ফেলবেন?</h2>
                <p className="text-sm text-gray-600 mb-5">এতে এই পাইকারের সব হিসাব/লেজার এন্ট্রিও একসাথে মুছে যাবে — এটা ফিরিয়ে আনা যাবে না।</p>
                <div className="flex gap-2">
                  <button onClick={() => setDeletingWholesalerId(null)} className="flex-1 bg-gray-100 text-gray-600 rounded-full py-3 text-sm font-semibold">
                    বাতিল
                  </button>
                  <button onClick={() => confirmDeleteWholesaler(deletingWholesalerId)} className="flex-1 bg-red-700 text-white rounded-full py-3 text-sm font-semibold active:bg-red-800">
                    মুছে ফেলুন
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // পার্টনার হিসাব — ফুল পেজ পোস্ট লগ (মডাল না, পুরো পেজ)
  if (showPartnerLogPage) {
    return (
      <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
        <div className="w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen relative pb-24 flex flex-col">
          {/* হেডার — চিকন, কফি কালার */}
          <div className="bg-emerald-700 text-white px-4 py-3 sticky top-0 z-10 flex items-center gap-3">
            <button onClick={() => setShowPartnerLogPage(false)} className="text-white shrink-0">
              <ChevronRight size={20} className="rotate-180" />
            </button>
            <h1 className="text-sm font-bold shrink-0">পার্টনার হিসাব</h1>
            <div className="flex gap-2 overflow-x-auto ml-1">
              {partners.map((p) => (
                <button
                  key={p.id}
                  onClick={() => openPartnerDetail(p)}
                  className="flex items-center gap-1 shrink-0 bg-white/10 rounded-full pl-1 pr-2.5 py-1"
                >
                  {p.photo_url ? (
                    <img src={p.photo_url} alt="" className="w-6 h-6 rounded-full object-cover" />
                  ) : (
                    <div className="w-6 h-6 rounded-full bg-amber-500 text-stone-900 flex items-center justify-center text-[10px] font-bold">
                      {p.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="text-[11px] text-white/90 max-w-[56px] truncate">{p.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* পোস্ট লগ / ফিড */}
          <div ref={partnerLogScrollRef} className="flex-1 overflow-y-auto px-4 py-4">
            {partnerLogLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 size={28} className="animate-spin text-[#034B58]" />
              </div>
            ) : allPartnerTransactions.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-10">এখনো কোনো পোস্ট নেই</p>
            ) : (
              <div className="flex flex-col gap-3">
                {allPartnerTransactions.map((t) => {
                  const isOwn = t.added_by_user_id === currentUser?.id;
                  const hasReactions = t.reaction_counts && Object.keys(t.reaction_counts).length > 0;
                  return (
                    <div key={t.id} className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'} relative`}>
                      {!isOwn && (
                        <div className="flex items-center gap-1.5 mb-1 ml-1">
                          {t.added_by_photo ? (
                            <img src={t.added_by_photo} alt="" className="w-5 h-5 rounded-full object-cover" />
                          ) : (
                            <div className="w-5 h-5 rounded-full bg-gray-300 text-gray-600 flex items-center justify-center text-[9px] font-bold">
                              {t.added_by_name.charAt(0).toUpperCase()}
                            </div>
                          )}
                          <span className="text-xs text-gray-500 font-medium">{t.added_by_name}</span>
                        </div>
                      )}

                      {reactingTxnId === t.id && (
                        <div className="absolute -top-11 z-20 bg-white rounded-full shadow-lg border border-gray-200 flex items-center gap-1 px-2 py-1.5">
                          <button
                            onClick={() => submitReaction(t.id, 'like', t.my_reaction)}
                            className="text-xl active:scale-125 transition-transform px-1"
                          >
                            👍
                          </button>
                          <button
                            onClick={() => submitReaction(t.id, 'love', t.my_reaction)}
                            className="text-xl active:scale-125 transition-transform px-1"
                          >
                            ❤️
                          </button>
                        </div>
                      )}

                      <div
                        onTouchStart={() => startLongPress(t.id)}
                        onTouchEnd={cancelLongPress}
                        onTouchMove={cancelLongPress}
                        onMouseDown={() => startLongPress(t.id)}
                        onMouseUp={cancelLongPress}
                        onMouseLeave={cancelLongPress}
                        className={`max-w-[80%] rounded-2xl px-4 py-2.5 select-none cursor-pointer ${
                          isOwn ? 'bg-emerald-700 text-white rounded-tr-sm' : 'bg-white text-gray-900 shadow-sm rounded-tl-sm'
                        }`}
                      >
                        {t.image_url && (
                          <img
                            src={t.image_url}
                            alt=""
                            onClick={(e) => { e.stopPropagation(); setViewingFullImage(t.image_url); }}
                            className="w-full rounded-xl mb-2 max-h-48 object-cover cursor-pointer"
                          />
                        )}
                        <p className="text-sm">{t.description}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`text-sm font-bold ${
                            t.type === 'cash_in'
                              ? (isOwn ? 'text-emerald-50' : 'text-emerald-700')
                              : (isOwn ? 'text-red-200' : 'text-red-700')
                          }`}>
                            {t.type === 'cash_in' ? '+' : '−'}৳{t.amount}
                          </span>
                          <span className={`text-[10px] ${isOwn ? 'text-white/60' : 'text-gray-400'}`}>
                            {new Date(t.event_time).toLocaleString('bn-BD', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}
                          </span>
                        </div>
                      </div>

                      {hasReactions && (
                        <button
                          onClick={() => setViewingReactorsTxn(t)}
                          className="flex items-center gap-1 mt-1 bg-white rounded-full shadow-sm px-2 py-0.5 border border-gray-100 active:bg-gray-50"
                        >
                          {Object.entries(t.reaction_counts).map(([type, count]) => (
                            <span key={type} className="text-xs flex items-center gap-0.5">
                              {type === 'like' ? '👍' : '❤️'} {count}
                            </span>
                          ))}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* নিচে কম্পোজ বার — শুধু পার্টনারদের জন্য */}
          {currentUser?.is_partner && (
            <div className="fixed bottom-0 w-full sm:max-w-sm bg-white border-t border-gray-200 p-3 flex gap-3">
              <button
                onClick={() => openAddPartnerTxn('cash_in')}
                className="flex-1 bg-emerald-600 text-white rounded-full py-2.5 text-sm font-semibold flex items-center justify-center gap-2 active:bg-emerald-700"
              >
                <Wallet size={16} /> ক্যাশ যোগ করুন
              </button>
              <button
                onClick={() => openAddPartnerTxn('expense')}
                className="flex-1 bg-[#075B68] text-white rounded-full py-2.5 text-sm font-semibold flex items-center justify-center gap-2 active:bg-[#034B58]"
              >
                <CreditCard size={16} /> খরচ যোগ করুন
              </button>
            </div>
          )}

          {/* পার্টনার হিসাব — বিস্তারিত (নামে ক্লিক করলে) */}
          {/* কে রিয়েক্ট দিয়েছে */}
          {viewingReactorsTxn && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50" onClick={() => setViewingReactorsTxn(null)}>
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-gray-900">কে রিয়েক্ট দিয়েছে</h2>
                  <button onClick={() => setViewingReactorsTxn(null)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {(viewingReactorsTxn.reactors || []).map((r, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 bg-gray-50 rounded-xl px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <span className="text-lg">{r.reaction_type === 'like' ? '👍' : '❤️'}</span>
                        <span className="text-sm text-gray-800">{r.user_name}</span>
                      </div>
                      {r.user_id === currentUser?.id && (
                        <button
                          onClick={() => removeMyReactionFromViewer(viewingReactorsTxn.id)}
                          className="text-xs font-semibold text-red-600 bg-red-50 rounded-full px-3 py-1"
                        >
                          সরিয়ে ফেলুন
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ছবি বড় করে দেখা — মেসেঞ্জার/হোয়াটসঅ্যাপের মতো */}
          {viewingFullImage && (
            <div
              className="fixed inset-0 bg-black/90 flex items-center justify-center z-[60]"
              onClick={() => setViewingFullImage(null)}
            >
              <button
                onClick={() => setViewingFullImage(null)}
                className="absolute top-6 right-6 w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white"
              >
                <X size={22} />
              </button>
              <img
                src={viewingFullImage}
                alt=""
                onClick={(e) => e.stopPropagation()}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          )}

          {/* নতুন/এডিট এন্ট্রি ফর্ম */}
          {partnerTxnForm && (
            <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
              <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-lg font-bold text-gray-900">
                    {partnerTxnForm.editingId
                      ? 'এন্ট্রি এডিট করুন'
                      : partnerTxnForm.type === 'expense'
                      ? 'খরচ যোগ করুন'
                      : 'ক্যাশ যোগ করুন'}
                  </h2>
                  <button onClick={() => setPartnerTxnForm(null)} className="text-gray-400">
                    <X size={22} />
                  </button>
                </div>

                <label className="text-xs font-semibold text-gray-500">
                  {partnerTxnForm.type === 'expense' ? 'কি কাজে খরচ হয়েছে?' : 'এই ক্যাশ কোথা থেকে এসেছে?'}
                </label>
                <input
                  type="text"
                  value={partnerTxnForm.description}
                  onChange={(e) => setPartnerTxnForm({ ...partnerTxnForm, description: e.target.value })}
                  className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder={partnerTxnForm.type === 'expense' ? 'যেমন: কাপড় কেনা' : 'যেমন: ব্যাংক থেকে তোলা'}
                  autoFocus
                />

                <label className="text-xs font-semibold text-gray-500 mt-4 block">কত টাকা?</label>
                <input
                  type="number"
                  value={partnerTxnForm.amount}
                  onChange={(e) => setPartnerTxnForm({ ...partnerTxnForm, amount: e.target.value })}
                  className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="যেমন: ৫০০০"
                />

                <label className="text-xs font-semibold text-gray-500 mt-4 block">ছবি (ঐচ্ছিক)</label>
                <label className="mt-1 flex items-center gap-3 border border-dashed border-gray-300 rounded-xl px-4 py-3 cursor-pointer">
                  {partnerTxnForm.image_url ? (
                    <img src={partnerTxnForm.image_url} alt="" className="w-14 h-14 rounded-lg object-cover" />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-gray-100 flex items-center justify-center">
                      <PlusCircle size={20} className="text-gray-400" />
                    </div>
                  )}
                  <span className="text-xs text-gray-500">
                    {partnerTxnForm.image_url ? 'ছবি বদলাতে ট্যাপ করুন' : 'ছবি সিলেক্ট করুন (ছবি ছাড়াও পোস্ট করা যাবে)'}
                  </span>
                  <input type="file" accept="image/*" onChange={handlePartnerTxnImageChange} className="hidden" />
                </label>

                {partnerTxnError && <p className="text-sm text-red-600 mt-3">{partnerTxnError}</p>}

                <button
                  onClick={submitPartnerTxn}
                  disabled={partnerTxnSubmitting}
                  className="w-full mt-5 bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                >
                  {partnerTxnSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                  {partnerTxnSubmitting ? 'সেভ হচ্ছে...' : partnerTxnForm.editingId ? 'আপডেট করুন' : 'সেভ করুন'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFA] flex justify-center">
      <div className={`w-full sm:max-w-sm bg-[#F8FAFA] min-h-screen relative pb-20 ${(cashMemoStaff || showExpenseReport) ? 'print:hidden' : ''}`}>

        {/* Header */}
        <div className="bg-gradient-to-br from-[#075B68] to-black rounded-b-3xl px-6 pt-8 pb-14 text-white">
          <p className="text-sm text-white/70 flex items-center gap-1.5">আসসালামু আলাইকুম <span>✨</span></p>
          <h1 className="text-2xl font-bold mt-1 tracking-wide">Maya Garments</h1>
          <p className="text-sm text-white/70 mt-1">ফ্যাক্টরি ড্যাশবোর্ডে স্বাগতম</p>
          <div className="absolute top-8 right-6 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center">
              <Bell size={18} />
            </div>
            <button
              onClick={() => setShowProfileMenu(true)}
              className="w-11 h-11 rounded-full bg-amber-500 text-[#075B68] flex items-center justify-center font-bold overflow-hidden"
            >
              {currentUser?.photo_url ? (
                <img src={currentUser.photo_url} alt="" className="w-full h-full object-cover" />
              ) : currentUser?.name ? currentUser.name.charAt(0).toUpperCase() : 'M'}
            </button>
          </div>
        </div>

        {/* Summary Card */}
        <div className="mx-4 -mt-10 bg-white rounded-2xl shadow-md border-2 border-gray-200 p-5">
          <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-amber-50 flex items-center justify-center">
                <Wallet size={22} className="text-amber-600" />
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-400 tracking-wide">মোট ব্যালেন্স (কারিগরদের পাওনা)</p>
                <p className="text-gray-800 font-medium">
                  {balanceHidden
                    ? 'দেখতে "ব্যালেন্স দেখুন" চাপুন'
                    : `৳ ${staffList.reduce((sum, s) => sum + computeStaffDue(s, paymentsSummaryAll, salarySummaryAll), 0).toFixed(2)}`}
                </p>
              </div>
            </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={handleShowBalance}
              className="flex-1 border border-[#075B68] text-[#075B68] rounded-full py-2.5 flex items-center justify-center gap-2 font-semibold text-sm active:bg-red-50"
            >
              <Eye size={16} /> ব্যালেন্স দেখুন
            </button>
            <button
              onClick={handleShowBalanceDetail}
              className="flex-1 bg-[#075B68] text-white rounded-full py-2.5 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58]"
            >
              <FileText size={16} /> বিস্তারিত দেখুন
            </button>
          </div>
        </div>

        {/* সারসংক্ষেপ */}
        <div className="px-4 mt-6 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900">সারসংক্ষেপ</h2>
          {lastUpdatedAt && (
            <p className="text-xs text-gray-400 flex items-center gap-1.5">
              সর্বশেষ আপডেট: {lastUpdatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            </p>
          )}
        </div>

        {/* Stat cards */}
        <div className="flex gap-3 px-4 mt-3">
          {stats.map((s, i) => (
            <div key={i} onClick={s.onClick} className="flex-1 bg-white rounded-2xl p-3.5 shadow-md border-2 border-gray-200 active:opacity-80 cursor-pointer">
              <div className="flex items-start justify-between">
                <div className={`w-9 h-9 rounded-lg ${s.bg} flex items-center justify-center`}>
                  {s.icon}
                </div>
                <span className={`w-2 h-2 rounded-full ${s.dot} mt-1`} />
              </div>
              <p className="text-lg font-bold text-gray-900 mt-2 leading-tight">{s.value}</p>
              <p className="text-xs text-gray-500 mt-0.5 leading-snug">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Quick actions */}
        <div className="px-4 mt-6">
          <h2 className="text-lg font-bold text-gray-900 mb-3">Quick actions</h2>
          <div className="grid grid-cols-4 gap-3">
            {quickActions.map((a, i) => (
              <button key={i} onClick={a.onClick} className="flex flex-col items-center gap-2 active:opacity-70">
                <div className={`w-14 h-14 rounded-2xl ${a.bg} border-2 border-gray-200 flex items-center justify-center shadow-md`}>
                  {a.icon}
                </div>
                <span className="text-xs text-gray-700 text-center leading-tight">{a.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* স্টাফ/কারিগর লিস্ট — প্রিভিউ */}
        <div className="px-4 mt-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-gray-900">স্টাফ/কারিগর লিস্ট</h2>
            <button onClick={() => setShowEmployeeModal(true)} className="text-xs font-semibold text-[#034B58] flex items-center gap-1">
              সব দেখুন →
            </button>
          </div>
          <button
            onClick={() => setShowEmployeeModal(true)}
            className="w-full bg-white rounded-2xl shadow-md border-2 border-gray-200 p-4 flex items-center gap-3 active:opacity-80 text-left"
          >
            <div className="flex -space-x-3 shrink-0">
              {staffList.slice(0, 3).map((s, i) => (
                <div
                  key={s.id}
                  className={`w-9 h-9 rounded-full border-2 border-white flex items-center justify-center text-xs font-bold text-white ${
                    ['bg-[#034B58]', 'bg-amber-600', 'bg-emerald-700'][i % 3]
                  }`}
                >
                  {s.name.charAt(0).toUpperCase()}
                </div>
              ))}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-gray-900 text-sm">মোট স্টাফ {staffList.length} জন</p>
              <p className="text-xs text-gray-500">আজ {presentCount} জন উপস্থিত</p>
              <div className="w-full h-1.5 bg-gray-100 rounded-full mt-1.5 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full"
                  style={{ width: `${staffList.length ? Math.round((presentCount / staffList.length) * 100) : 0}%` }}
                />
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-bold text-emerald-700">
                {staffList.length ? Math.round((presentCount / staffList.length) * 100) : 0}%
              </p>
            </div>
          </button>
        </div>

        {/* Help banner */}
        <div className="mx-4 mt-6 bg-white rounded-2xl shadow-md border-2 border-gray-200 p-4 flex items-center gap-3 active:bg-gray-50">
          <div className="w-11 h-11 rounded-xl bg-[#2587A5]/10 flex items-center justify-center">
            <LifeBuoy size={20} className="text-[#2587A5]" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-gray-900 text-sm">সাহায্য দরকার?</p>
            <p className="text-xs text-gray-500">রিপোর্ট বা সাপোর্ট দেখুন</p>
          </div>
          <ChevronRight size={20} className="text-gray-400" />
        </div>

        {/* Bottom nav */}
        <div className="fixed bottom-0 w-full sm:max-w-sm bg-white border-t border-gray-200 flex justify-around py-2.5">
          {navItems.map((n, i) => (
            <button
              key={i}
              onClick={
                n.label === 'অ্যালার্ট' ? openNotifications :
                n.label === 'প্রোফাইল' ? () => setShowProfileMenu(true) :
                n.label === 'প্রোডাকশন' ? openOrderManagementPage :
                undefined
              }
              className={`relative flex flex-col items-center gap-1 px-4 ${n.active ? 'text-[#075B68]' : 'text-gray-400'}`}
            >
              {n.icon}
              {n.label === 'অ্যালার্ট' && unreadCount > 0 && (
                <span className="absolute -top-0.5 right-2 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
              <span className="text-xs font-medium">{n.label}</span>
            </button>
          ))}
        </div>

        {/* Employee List Modal */}
        {/* Add Staff Modal */}
        {showAddForm && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">
                  {editingStaffId ? 'স্টাফ/কারিগর এডিট করুন' : 'নতুন স্টাফ/কারিগর যোগ করুন'}
                </h2>
                <button
                  onClick={() => {
                    setShowAddForm(false);
                    setEditingStaffId(null);
                    setForm({ name: '', phone: '', designation: '', joining_date: '', rate_type: 'piece', rate_amount: '', machine_user_id: '' });
                  }}
                  className="text-gray-400"
                >
                  <X size={22} />
                </button>
              </div>

              <form onSubmit={handleAddStaff} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500">নাম *</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: করিম মিয়া"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-gray-500">ফোন নাম্বার</label>
                  <input
                    type="text"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: ০১৭xxxxxxxx"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-gray-500">পদবি/কাজের ধরন</label>
                  <input
                    type="text"
                    value={form.designation}
                    onChange={(e) => setForm({ ...form, designation: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: সেলাই, কাটিং, ফিনিশিং"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-gray-500">যোগদানের তারিখ</label>
                  <input
                    type="date"
                    value={form.joining_date}
                    onChange={(e) => setForm({ ...form, joining_date: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-gray-500">মেশিন ইউজার আইডি (ফিঙ্গারপ্রিন্ট)</label>
                  <input
                    type="text"
                    value={form.machine_user_id}
                    onChange={(e) => setForm({ ...form, machine_user_id: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: 3"
                  />
                  <p className="text-xs text-gray-400 mt-1 leading-snug">
                    প্রথমে মেশিনে গিয়ে এই কারিগরের আঙুলের ছাপ রেকর্ড করুন (User Management থেকে), তারপর মেশিন যে নাম্বারটা দেয় সেটা এখানে বসান। না দিলে ফিঙ্গারপ্রিন্ট দিয়ে উপস্থিতি গণনা হবে না, শুধু ম্যানুয়ালি করতে হবে।
                  </p>
                </div>

                <div>
                  <label className="text-xs font-semibold text-gray-500">রেটের ধরন</label>
                  <div className="flex gap-3 mt-1">
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, rate_type: 'piece' })}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border ${form.rate_type === 'piece' ? 'bg-[#075B68] text-white border-[#075B68]' : 'border-gray-200 text-gray-600'}`}
                    >
                      প্রোডাকশন
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, rate_type: 'monthly' })}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border ${form.rate_type === 'monthly' ? 'bg-[#075B68] text-white border-[#075B68]' : 'border-gray-200 text-gray-600'}`}
                    >
                      মাসিক বেতন
                    </button>
                  </div>
                </div>

                {form.rate_type === 'monthly' && (
                  <div>
                    <label className="text-xs font-semibold text-gray-500">মাসিক বেতন (৳)</label>
                    <input
                      type="number"
                      value={form.rate_amount}
                      onChange={(e) => setForm({ ...form, rate_amount: e.target.value })}
                      className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                      placeholder="যেমন: ৮০০০"
                    />
                  </div>
                )}

                {formError && (
                  <p className="text-sm text-red-600">{formError}</p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                >
                  {submitting ? <Loader2 size={18} className="animate-spin" /> : <UserPlus size={18} />}
                  {submitting ? 'সেভ হচ্ছে...' : editingStaffId ? 'আপডেট করুন' : 'সেভ করুন'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Duty Schedule Form */}
        {showDutyForm && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">ডিউটি টাইম যুক্ত করুন</h2>
                <button onClick={() => setShowDutyForm(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <form onSubmit={handleSaveDuty} className="space-y-4">
                <p className="text-xs font-bold text-amber-700 uppercase">শিফট ১</p>
                <div>
                  <label className="text-xs font-semibold text-gray-500">শিফট শুরুর সময়</label>
                  <input
                    type="time"
                    value={dutyForm.shift1_start}
                    onChange={(e) => setDutyForm({ ...dutyForm, shift1_start: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500">শিফট শেষের সময়</label>
                  <input
                    type="time"
                    value={dutyForm.shift1_end}
                    onChange={(e) => setDutyForm({ ...dutyForm, shift1_end: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  />
                </div>

                <p className="text-xs font-bold text-amber-700 uppercase pt-2">শিফট ২</p>
                <div>
                  <label className="text-xs font-semibold text-gray-500">শিফট শুরুর সময়</label>
                  <input
                    type="time"
                    value={dutyForm.shift2_start}
                    onChange={(e) => setDutyForm({ ...dutyForm, shift2_start: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500">শিফট শেষের সময়</label>
                  <input
                    type="time"
                    value={dutyForm.shift2_end}
                    onChange={(e) => setDutyForm({ ...dutyForm, shift2_end: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  />
                </div>

                <p className="text-xs text-gray-400">
                  প্রতিটা শিফটে ৩০ মিনিট আগে থেকে ২০ মিনিট পর পর্যন্ত ফিঙ্গার দিলে "অন টাইম" ধরা হবে।
                </p>

                <button
                  type="submit"
                  disabled={dutySubmitting}
                  className="w-full bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                >
                  {dutySubmitting ? <Loader2 size={18} className="animate-spin" /> : <Clock size={18} />}
                  {dutySubmitting ? 'সেভ হচ্ছে...' : 'সেভ করুন'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Machine Form */}
        {showMachineForm && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">
                  {editingMachineId ? 'মেশিন এডিট করুন' : 'ফিঙ্গারপ্রিন্ট মেশিন যোগ করুন'}
                </h2>
                <button onClick={() => { setShowMachineForm(false); cancelEditMachine(); }} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <form onSubmit={handleAddMachine} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500">মেশিনের নাম *</label>
                  <input
                    type="text"
                    value={machineForm.name}
                    onChange={(e) => setMachineForm({ ...machineForm, name: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: মেইন গেট মেশিন"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500">IP অ্যাড্রেস *</label>
                  <input
                    type="text"
                    value={machineForm.ip_address}
                    onChange={(e) => setMachineForm({ ...machineForm, ip_address: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: 192.168.1.201"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500">পোর্ট</label>
                  <input
                    type="text"
                    value={machineForm.port}
                    onChange={(e) => setMachineForm({ ...machineForm, port: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="ডিফল্ট: 4370"
                  />
                </div>

                {machineError && <p className="text-sm text-red-600">{machineError}</p>}

                <button
                  type="submit"
                  disabled={machineSubmitting}
                  className="w-full bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                >
                  {machineSubmitting ? <Loader2 size={18} className="animate-spin" /> : <Server size={18} />}
                  {machineSubmitting ? 'সেভ হচ্ছে...' : editingMachineId ? 'আপডেট করুন' : 'সেভ করুন'}
                </button>
                {editingMachineId && (
                  <button
                    type="button"
                    onClick={cancelEditMachine}
                    className="w-full text-center text-sm text-gray-500 py-1"
                  >
                    বাতিল করুন
                  </button>
                )}
              </form>

              {machines.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-sm font-bold text-gray-900 mb-3">যোগ করা মেশিনসমূহ</h3>
                  <div className="flex flex-col gap-3">
                    {machines.map((m) => (
                      <div key={m.id} className="bg-white rounded-2xl shadow-md p-4 border-l-4 border-[#034B58] flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold text-gray-900 text-sm">{m.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{m.ip_address}:{m.port}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => startEditMachine(m)}
                            className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center"
                          >
                            <Pencil size={15} className="text-amber-700" />
                          </button>
                          <button
                            onClick={() => deleteMachine(m.id)}
                            className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center"
                          >
                            <Trash2 size={15} className="text-red-700" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-6 bg-amber-50 rounded-2xl p-4">
                <h3 className="text-sm font-bold text-gray-900 mb-1">সিঙ্ক ইন্টারভাল</h3>
                <p className="text-xs text-gray-500 mb-3">কত সেকেন্ড পরপর মেশিন থেকে ডেটা টানা হবে (সর্বনিম্ন ১০ সেকেন্ড)</p>
                <div className="flex gap-3">
                  <input
                    type="number"
                    min="10"
                    value={syncInterval}
                    onChange={(e) => setSyncInterval(e.target.value)}
                    className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58] bg-white"
                    placeholder="যেমন: 30"
                  />
                  <button
                    onClick={saveSyncInterval}
                    disabled={syncIntervalSaving}
                    className="bg-[#075B68] text-white rounded-xl px-5 py-2.5 text-sm font-semibold flex items-center gap-2 active:bg-[#034B58] disabled:opacity-60"
                  >
                    {syncIntervalSaving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                    {syncIntervalSaved ? 'সেভ হয়েছে' : 'সেভ'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Product Form */}
        {showProductForm && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">
                  {editingProductId ? 'প্রোডাক্ট এডিট করুন' : 'নতুন প্রোডাক্ট যোগ করুন'}
                </h2>
                <button onClick={() => { setShowProductForm(false); cancelEditProduct(); }} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <form onSubmit={handleAddProduct} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500">প্রোডাক্টের নাম *</label>
                  <input
                    type="text"
                    value={productForm.name}
                    onChange={(e) => setProductForm({ ...productForm, name: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: শার্ট, প্যান্ট"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500">সেলাই মূল্য (৳ প্রতি পিস)</label>
                  <input
                    type="number"
                    value={productForm.sewing_price}
                    onChange={(e) => setProductForm({ ...productForm, sewing_price: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: ৩৫"
                  />
                </div>

                {editingProductId && (
                  <label className="flex items-start gap-2.5 bg-amber-50 rounded-xl p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={applyPriceToExisting}
                      onChange={(e) => setApplyPriceToExisting(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-xs text-gray-700">
                      কারিগরের আগের হিসাবেও এই দাম যোগ করতে চান? (টিক দিলে আগের সব এন্ট্রি নতুন দামে রিক্যালকুলেট হবে)
                    </span>
                  </label>
                )}

                {productError && <p className="text-sm text-red-600">{productError}</p>}

                <button
                  type="submit"
                  disabled={productSubmitting}
                  className="w-full bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                >
                  {productSubmitting ? <Loader2 size={18} className="animate-spin" /> : <PlusCircle size={18} />}
                  {productSubmitting ? 'সেভ হচ্ছে...' : editingProductId ? 'আপডেট করুন' : 'সেভ করুন'}
                </button>
                {editingProductId && (
                  <button type="button" onClick={cancelEditProduct} className="w-full text-center text-sm text-gray-500 py-1">
                    বাতিল করুন
                  </button>
                )}
              </form>

              {products.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-sm font-bold text-gray-900 mb-3">প্রোডাক্ট লিস্ট</h3>
                  <div className="flex flex-col gap-3">
                    {products.map((p) => (
                      <div key={p.id} className="bg-white rounded-2xl shadow-md p-4 flex items-center justify-between border-l-4 border-amber-500">
                        <div>
                          <p className="font-semibold text-gray-900 text-sm">{p.name}</p>
                          <p className="text-sm font-semibold text-[#034B58] mt-0.5">৳ {p.sewing_price}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => startEditProduct(p)}
                            className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center"
                          >
                            <Pencil size={15} className="text-amber-700" />
                          </button>
                          <button
                            onClick={() => deleteProduct(p.id)}
                            className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center"
                          >
                            <Trash2 size={15} className="text-red-700" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* কারিগর হিসাব — Step 1: স্টাফ সিলেক্ট (শুধু প্রোডাকশন-টাইপ কারিগর) */}
        {/* কারিগর হিসাব — Step 2: প্রোডাক্ট সিলেক্ট */}
        {/* কারিগর হিসাব — Step 3: পিস সংখ্যা লিখুন, অটো ক্যালকুলেশন */}
        {showKarigorHisab && karigorStep === 'enter-qty' && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">
                  {editingProductionEntryId && <span className="text-emerald-700 text-xs block mb-0.5">এডিট করছেন</span>}
                  {karigorStaff?.name} — {karigorProduct?.name}
                </h2>
                <button onClick={() => { setShowKarigorHisab(false); setEditingProductionEntryId(null); }} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <label className="text-xs font-semibold text-gray-500">কত পিস তৈরি হয়েছে?</label>
              <input
                type="number"
                value={karigorQty}
                onChange={(e) => setKarigorQty(e.target.value)}
                className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="যেমন: ৫০"
                autoFocus
              />

              <label className="text-xs font-semibold text-gray-500">কোন তারিখে?</label>
              <input
                type="date"
                value={karigorEntryDate}
                onChange={(e) => setKarigorEntryDate(e.target.value)}
                className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
              />

              <div className="mt-4 bg-amber-50 rounded-2xl p-4 flex items-center justify-between">
                <span className="text-sm text-gray-600">মোট হবে</span>
                <span className="text-lg font-bold text-[#034B58]">
                  ৳ {karigorQty && !isNaN(karigorQty) ? (parseFloat(karigorQty) * parseFloat(karigorProduct?.sewing_price || 0)).toFixed(2) : '0.00'}
                </span>
              </div>

              {karigorError && <p className="text-sm text-red-600 mt-3">{karigorError}</p>}

              <button
                onClick={submitProductionEntry}
                disabled={karigorSubmitting}
                className="w-full mt-5 bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
              >
                {karigorSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                {karigorSubmitting ? 'সেভ হচ্ছে...' : 'সেভ করুন'}
              </button>
            </div>
          </div>
        )}

        {/* ফান্ড/খরচ — অপশন চয়েস */}
        {showFundChoice && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">ফান্ড/খরচ</h2>
                <button onClick={() => setShowFundChoice(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => { setShowFundChoice(false); setShowExpenseForm(true); fetchExpenses(); }}
                  className="bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 border-[#034B58] active:opacity-80 text-left"
                >
                  <div className="w-11 h-11 rounded-xl bg-red-100 flex items-center justify-center">
                    <CreditCard size={20} className="text-red-800" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">ফ্যাক্টরি খরচ</p>
                    <p className="text-xs text-gray-500">কারেন্ট বিল, ভাড়া ইত্যাদি</p>
                  </div>
                </button>
                <button
                  onClick={() => { setShowFundChoice(false); setShowWeeklyPicker(true); setEditingPaymentId(null); setWeeklyStaff(null); setWeeklyAmount(''); fetchRecentPayments(); }}
                  className="bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 border-amber-500 active:opacity-80 text-left"
                >
                  <div className="w-11 h-11 rounded-xl bg-amber-100 flex items-center justify-center">
                    <Wallet size={20} className="text-amber-700" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">স্টাফ/কারিগরের সাপ্তাহিক</p>
                    <p className="text-xs text-gray-500">এডভান্স/সাপ্তাহিক পেমেন্ট দিন</p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ফ্যাক্টরি খরচ ফর্ম */}
        {showExpenseForm && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">ফ্যাক্টরি খরচ যোগ করুন</h2>
                <button onClick={() => setShowExpenseForm(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <form onSubmit={handleAddExpense} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500">বিবরণ *</label>
                  <input
                    type="text"
                    value={expenseForm.description}
                    onChange={(e) => setExpenseForm({ ...expenseForm, description: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: কারেন্ট বিল"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500">টাকার পরিমাণ (৳) *</label>
                  <input
                    type="number"
                    value={expenseForm.amount}
                    onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: ৫০০০"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500">তারিখ</label>
                  <input
                    type="date"
                    value={expenseForm.expense_date}
                    onChange={(e) => setExpenseForm({ ...expenseForm, expense_date: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  />
                </div>

                {expenseError && <p className="text-sm text-red-600">{expenseError}</p>}

                <button
                  type="submit"
                  disabled={expenseSubmitting}
                  className="w-full bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                >
                  {expenseSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CreditCard size={18} />}
                  {expenseSubmitting ? 'সেভ হচ্ছে...' : 'সেভ করুন'}
                </button>
              </form>

              {expenses.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-sm font-bold text-gray-900 mb-3">সাম্প্রতিক খরচ</h3>
                  <div className="flex flex-col gap-3">
                    {expenses.map((ex) => (
                      <div key={ex.id} className="bg-white rounded-2xl shadow-md p-4 flex items-center justify-between border-l-4 border-[#034B58]">
                        <div>
                          <p className="font-semibold text-gray-900 text-sm">{ex.description}</p>
                          <p className="text-xs text-gray-400">{ex.expense_date?.slice(0, 10)}</p>
                        </div>
                        <p className="text-sm font-semibold text-[#034B58]">৳ {ex.amount}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* স্টাফ/কারিগরের সাপ্তাহিক — স্টাফ পিকার */}
        {/* স্টাফ/কারিগরের সাপ্তাহিক — টাকার পরিমাণ */}

        {/* স্টাফ/কারিগরের সাপ্তাহিক — টাকার পরিমাণ */}
        {showWeeklyPicker && weeklyStaff && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">
                  {editingPaymentId && <span className="text-emerald-700 text-xs block mb-0.5">এডিট করছেন</span>}
                  {weeklyStaff.name} — সাপ্তাহিক পেমেন্ট
                </h2>
                <button onClick={() => { setShowWeeklyPicker(false); setWeeklyStaff(null); setEditingPaymentId(null); }} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <label className="text-xs font-semibold text-gray-500">কত টাকা দেওয়া হয়েছে?</label>
              <input
                type="number"
                value={weeklyAmount}
                onChange={(e) => setWeeklyAmount(e.target.value)}
                className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="যেমন: ২০০০"
                autoFocus
              />

              <label className="text-xs font-semibold text-gray-500">কোন তারিখে?</label>
              <input
                type="date"
                value={weeklyPaymentDate}
                onChange={(e) => setWeeklyPaymentDate(e.target.value)}
                className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
              />

              {weeklyError && <p className="text-sm text-red-600 mt-3">{weeklyError}</p>}

              <button
                onClick={submitWeeklyPayment}
                disabled={weeklySubmitting}
                className="w-full mt-5 bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
              >
                {weeklySubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                {weeklySubmitting ? 'সেভ হচ্ছে...' : editingPaymentId ? 'আপডেট করুন' : 'সেভ করুন'}
              </button>
            </div>
          </div>
        )}

        {/* মোট ব্যালেন্স — বিস্তারিত (কে কত পাবে) */}
        {showBalanceDetail && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50 print:hidden">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">কে কত পাবে</h2>
                <button onClick={() => setShowBalanceDetail(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <div className="relative mb-4">
                <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={staffSearchQuery}
                  onChange={(e) => setStaffSearchQuery(e.target.value)}
                  placeholder="নাম বা ফোন নাম্বার দিয়ে সার্চ করুন"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 text-sm focus:outline-none focus:border-[#034B58] bg-white"
                />
              </div>

              {staffList.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো স্টাফ যোগ করা হয়নি</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {staffList.filter(matchesStaffSearch).map((s) => {
                    const due = computeStaffDue(s, paymentsSummaryAll, salarySummaryAll);
                    return (
                      <button
                        key={s.id}
                        onClick={() => openCashMemo(s)}
                        className={`text-left bg-white rounded-2xl shadow-md p-4 flex items-center justify-between gap-3 border-l-4 ${
                          s.rate_type === 'monthly' ? 'border-[#034B58]' : 'border-amber-500'
                        } active:opacity-80`}
                      >
                        <div>
                          <p className="font-semibold text-gray-900 text-sm">{s.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{s.designation || 'পদবি নেই'}</p>
                        </div>
                        <p className={`text-sm font-semibold ${due > 0 ? 'text-[#034B58]' : 'text-emerald-700'}`}>
                          ৳ {due.toFixed(2)}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}


        {/* প্রোফাইল / লগআউট মেনু */}
        {showProfileMenu && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">প্রোফাইল</h2>
                <button onClick={() => setShowProfileMenu(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <button
                onClick={openEditProfile}
                className="w-full bg-white rounded-2xl shadow-md p-4 border-l-4 border-[#034B58] mb-4 flex items-center gap-3 active:opacity-80 text-left"
              >
                {currentUser?.photo_url ? (
                  <img src={currentUser.photo_url} alt="" className="w-12 h-12 rounded-full object-cover shrink-0" />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-amber-500 text-[#075B68] flex items-center justify-center font-bold text-lg shrink-0">
                    {currentUser?.name ? currentUser.name.charAt(0).toUpperCase() : 'M'}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 text-sm">{currentUser?.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{currentUser?.phone}</p>
                  <p className="text-xs text-amber-700 font-semibold mt-1 uppercase">{currentUser?.role}</p>
                </div>
                <ChevronRight size={18} className="text-gray-400 shrink-0" />
              </button>

              <button
                onClick={() => { setShowProfileMenu(false); setShowMachineForm(true); fetchMachines(); fetchSyncInterval(); }}
                className="w-full bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 border-stone-500 mb-3 active:opacity-80 text-left"
              >
                <div className="w-11 h-11 rounded-xl bg-stone-200 flex items-center justify-center">
                  <Server size={20} className="text-stone-700" />
                </div>
                <div>
                  <p className="font-semibold text-gray-900 text-sm">মেশিন যোগ করুন</p>
                  <p className="text-xs text-gray-500">ফিঙ্গারপ্রিন্ট মেশিন ও সিঙ্ক সেটিংস</p>
                </div>
              </button>

              <button
                onClick={() => { setShowProfileMenu(false); openLateGraceForm(); }}
                className="w-full bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 border-orange-500 mb-3 active:opacity-80 text-left"
              >
                <div className="w-11 h-11 rounded-xl bg-orange-100 flex items-center justify-center">
                  <Clock size={20} className="text-orange-700" />
                </div>
                <div>
                  <p className="font-semibold text-gray-900 text-sm">লেট গ্রেস টাইম</p>
                  <p className="text-xs text-gray-500">কত মিনিট পর্যন্ত দেরি হলে "লেট" গণনা হবে না</p>
                </div>
              </button>

              {currentUser?.is_super_admin && (
                <button
                  onClick={() => { setShowProfileMenu(false); openPreviousBalancePage(); }}
                  className="w-full bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 border-teal-500 mb-3 active:opacity-80 text-left"
                >
                  <div className="w-11 h-11 rounded-xl bg-teal-100 flex items-center justify-center">
                    <Wallet size={20} className="text-teal-700" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">আগের হিসাব যোগ করুন</p>
                    <p className="text-xs text-gray-500">স্টাফের পুরনো পাওনা/দেনা সমন্বয় করুন</p>
                  </div>
                </button>
              )}

              {currentUser?.role === 'admin' && (
                <button
                  onClick={() => { setShowProfileMenu(false); openOrderPagesPage(); }}
                  className="w-full bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 border-fuchsia-500 mb-3 active:opacity-80 text-left"
                >
                  <div className="w-11 h-11 rounded-xl bg-fuchsia-100 flex items-center justify-center">
                    <FileText size={20} className="text-fuchsia-700" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">পেইজ যোগ করুন</p>
                    <p className="text-xs text-gray-500">অর্ডার ম্যানেজমেন্ট — কুরিয়ার/AI ক্রেডেনশিয়াল</p>
                  </div>
                </button>
              )}

              {currentUser?.role === 'admin' && (
                <button
                  onClick={() => { setShowProfileMenu(false); setShowUserManagement(true); fetchUsers(); }}
                  className="w-full bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 border-amber-500 mb-3 active:opacity-80 text-left"
                >
                  <div className="w-11 h-11 rounded-xl bg-amber-100 flex items-center justify-center">
                    <ShieldCheck size={20} className="text-amber-700" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">ইউজার ম্যানেজমেন্ট</p>
                    <p className="text-xs text-gray-500">নতুন এডমিন/মডারেটর যোগ করুন</p>
                  </div>
                </button>
              )}

              {currentUser?.is_super_admin && (
                <button
                  onClick={() => { setShowProfileMenu(false); setShowResetConfirm(true); setResetPasswordInput(''); setResetError(''); }}
                  className="w-full bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 border-[#034B58] mb-3 active:opacity-80 text-left"
                >
                  <div className="w-11 h-11 rounded-xl bg-red-100 flex items-center justify-center">
                    <Trash2 size={20} className="text-red-700" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">আজকের উপস্থিতি রিসেট করুন</p>
                    <p className="text-xs text-gray-500">পাসওয়ার্ড লাগবে — সংবেদনশীল, বেতনের সাথে সংযুক্ত</p>
                  </div>
                </button>
              )}

              {currentUser?.is_super_admin && (
                <button
                  onClick={() => { setShowProfileMenu(false); setShowPaymentResetConfirm(true); setPaymentResetPasswordInput(''); setPaymentResetError(''); }}
                  className="w-full bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 border-[#034B58] mb-3 active:opacity-80 text-left"
                >
                  <div className="w-11 h-11 rounded-xl bg-red-100 flex items-center justify-center">
                    <Trash2 size={20} className="text-red-700" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">সব স্টাফ পেমেন্ট রিসেট করুন</p>
                    <p className="text-xs text-gray-500">টেস্ট ডেটা মুছতে — পাসওয়ার্ড লাগবে, সংবেদনশীল</p>
                  </div>
                </button>
              )}

              {currentUser?.is_super_admin && (
                <button
                  onClick={() => { setShowProfileMenu(false); setShowPartnerResetConfirm(true); setPartnerResetPasswordInput(''); setPartnerResetError(''); }}
                  className="w-full bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 border-[#034B58] mb-3 active:opacity-80 text-left"
                >
                  <div className="w-11 h-11 rounded-xl bg-red-100 flex items-center justify-center">
                    <Trash2 size={20} className="text-red-700" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900 text-sm">সব পার্টনার হিসাব রিসেট করুন</p>
                    <p className="text-xs text-gray-500">সব পার্টনারের সব এন্ট্রি + নোটিফিকেশন মুছে যাবে — পাসওয়ার্ড লাগবে</p>
                  </div>
                </button>
              )}

              <button
                onClick={onLogout}
                className="w-full bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58]"
              >
                <LogOut size={18} /> লগআউট
              </button>
            </div>
          </div>
        )}

        {/* লেট গ্রেস টাইম সেটিংস */}
        {showLateGraceForm && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-6">
            <div className="w-full sm:max-w-sm bg-white rounded-3xl p-6">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-lg font-bold text-gray-900">লেট গ্রেস টাইম</h2>
                <button onClick={() => setShowLateGraceForm(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                শিফট শুরুর কত মিনিট পর পর্যন্ত পৌঁছানো "লেট" হিসেবে গণনা হবে না — এর বেশি দেরি হলেই লেট ধরা হবে
              </p>
              <div className="flex gap-3">
                <input
                  type="number"
                  min="0"
                  max="180"
                  value={lateGraceMinutes}
                  onChange={(e) => setLateGraceMinutes(e.target.value)}
                  className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="যেমন: 20"
                />
                <button
                  onClick={saveLateGrace}
                  disabled={lateGraceSaving}
                  className="bg-[#075B68] text-white rounded-xl px-5 py-2.5 text-sm font-semibold flex items-center gap-2 active:bg-[#034B58] disabled:opacity-60"
                >
                  {lateGraceSaving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                  {lateGraceSaved ? 'সেভ হয়েছে' : 'সেভ'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* প্রোফাইল এডিট — নাম, ছবি, পাসওয়ার্ড */}
        {showEditProfile && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">প্রোফাইল এডিট করুন</h2>
                <button onClick={() => setShowEditProfile(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <div className="flex flex-col items-center mb-5">
                <label className="relative cursor-pointer">
                  {profileForm.photo_url ? (
                    <img src={profileForm.photo_url} alt="" className="w-20 h-20 rounded-full object-cover" />
                  ) : (
                    <div className="w-20 h-20 rounded-full bg-amber-500 text-[#075B68] flex items-center justify-center font-bold text-2xl">
                      {profileForm.name ? profileForm.name.charAt(0).toUpperCase() : 'M'}
                    </div>
                  )}
                  <div className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-[#075B68] flex items-center justify-center border-2 border-white">
                    <Pencil size={12} className="text-white" />
                  </div>
                  <input type="file" accept="image/*" onChange={handleProfilePhotoChange} className="hidden" />
                </label>
                <p className="text-xs text-gray-400 mt-2">ছবি বদলাতে ট্যাপ করুন</p>
              </div>

              <label className="text-xs font-semibold text-gray-500">নাম</label>
              <input
                type="text"
                value={profileForm.name}
                onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
              />

              <label className="text-xs font-semibold text-gray-500">ফোন নাম্বার</label>
              <input
                type="text"
                value={currentUser?.phone || ''}
                disabled
                className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm bg-gray-100 text-gray-500"
              />

              <div className="border-t border-gray-200 pt-4 mt-2">
                <p className="text-sm font-bold text-gray-900 mb-3">পাসওয়ার্ড পরিবর্তন করুন (ঐচ্ছিক)</p>
                <label className="text-xs font-semibold text-gray-500">বর্তমান পাসওয়ার্ড</label>
                <input
                  type="password"
                  value={profileForm.current_password}
                  onChange={(e) => setProfileForm({ ...profileForm, current_password: e.target.value })}
                  className="w-full mt-1 mb-4 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="পরিবর্তন করতে চাইলে লিখুন"
                />
                <label className="text-xs font-semibold text-gray-500">নতুন পাসওয়ার্ড</label>
                <input
                  type="password"
                  value={profileForm.new_password}
                  onChange={(e) => setProfileForm({ ...profileForm, new_password: e.target.value })}
                  className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                  placeholder="নতুন পাসওয়ার্ড লিখুন"
                />
              </div>

              {profileError && <p className="text-sm text-red-600 mt-4">{profileError}</p>}
              {profileSuccess && <p className="text-sm text-emerald-600 mt-4">{profileSuccess}</p>}

              <button
                onClick={submitProfileUpdate}
                disabled={profileSubmitting}
                className="w-full mt-5 bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
              >
                {profileSubmitting ? <Loader2 size={18} className="animate-spin" /> : <CheckCircle2 size={18} />}
                {profileSubmitting ? 'সেভ হচ্ছে...' : 'সেভ করুন'}
              </button>
            </div>
          </div>
        )}

        {/* আজকের উপস্থিতি রিসেট — পাসওয়ার্ড কনফার্মেশন */}
        {showResetConfirm && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">আজকের উপস্থিতি রিসেট করুন</h2>
                <button onClick={() => setShowResetConfirm(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <p className="text-sm text-gray-600 mb-4">
                এটা করলে আজকের সব উপস্থিতির রেকর্ড মুছে যাবে, ফেরত আনা যাবে না। নিশ্চিত হলে পাসওয়ার্ড লিখুন।
              </p>

              <label className="text-xs font-semibold text-gray-500">পাসওয়ার্ড</label>
              <input
                type="password"
                value={resetPasswordInput}
                onChange={(e) => setResetPasswordInput(e.target.value)}
                className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="পাসওয়ার্ড লিখুন"
                autoFocus
              />

              {resetError && <p className="text-sm text-red-600 mt-3">{resetError}</p>}

              <button
                onClick={confirmResetAttendance}
                disabled={resetSubmitting}
                className="w-full mt-5 bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
              >
                {resetSubmitting ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {resetSubmitting ? 'রিসেট হচ্ছে...' : 'রিসেট নিশ্চিত করুন'}
              </button>
            </div>
          </div>
        )}

        {/* সব স্টাফ পেমেন্ট রিসেট — পাসওয়ার্ড কনফার্মেশন */}
        {showPaymentResetConfirm && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">সব স্টাফ পেমেন্ট রিসেট করুন</h2>
                <button onClick={() => setShowPaymentResetConfirm(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <p className="text-sm text-gray-600 mb-4">
                এটা করলে এখন পর্যন্ত সব স্টাফ/কারিগরকে দেওয়া পেমেন্টের রেকর্ড মুছে যাবে, ফেরত আনা যাবে না। নিশ্চিত হলে পাসওয়ার্ড লিখুন।
              </p>

              <label className="text-xs font-semibold text-gray-500">পাসওয়ার্ড</label>
              <input
                type="password"
                value={paymentResetPasswordInput}
                onChange={(e) => setPaymentResetPasswordInput(e.target.value)}
                className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="পাসওয়ার্ড লিখুন"
                autoFocus
              />

              {paymentResetError && <p className="text-sm text-red-600 mt-3">{paymentResetError}</p>}

              <button
                onClick={confirmPaymentReset}
                disabled={paymentResetSubmitting}
                className="w-full mt-5 bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
              >
                {paymentResetSubmitting ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {paymentResetSubmitting ? 'রিসেট হচ্ছে...' : 'রিসেট নিশ্চিত করুন'}
              </button>
            </div>
          </div>
        )}

        {/* সব পার্টনার হিসাব রিসেট — পাসওয়ার্ড কনফার্মেশন */}
        {showPartnerResetConfirm && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">সব পার্টনার হিসাব রিসেট করুন</h2>
                <button onClick={() => setShowPartnerResetConfirm(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <p className="text-sm text-gray-600 mb-4">
                এটা করলে সব পার্টনারের সব খরচ/ক্যাশ এন্ট্রি এবং নোটিফিকেশন — একদম সব জায়গা থেকে মুছে যাবে (পার্টনারের নিজের হিসাব, "খরচের বিস্তারিত" রিপোর্ট, সবকিছু), ফেরত আনা যাবে না। নিশ্চিত হলে পাসওয়ার্ড লিখুন।
              </p>

              <label className="text-xs font-semibold text-gray-500">পাসওয়ার্ড</label>
              <input
                type="password"
                value={partnerResetPasswordInput}
                onChange={(e) => setPartnerResetPasswordInput(e.target.value)}
                className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="পাসওয়ার্ড লিখুন"
                autoFocus
              />

              {partnerResetError && <p className="text-sm text-red-600 mt-3">{partnerResetError}</p>}

              <button
                onClick={confirmPartnerReset}
                disabled={partnerResetSubmitting}
                className="w-full mt-5 bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
              >
                {partnerResetSubmitting ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {partnerResetSubmitting ? 'রিসেট হচ্ছে...' : 'রিসেট নিশ্চিত করুন'}
              </button>
            </div>
          </div>
        )}

        {/* পাইকার — পাসওয়ার্ড লক */}
        {showWholesalerLockPrompt && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">পাসওয়ার্ড দিন</h2>
                <button onClick={() => setShowWholesalerLockPrompt(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <label className="text-xs font-semibold text-gray-500">পাসওয়ার্ড</label>
              <input
                type="password"
                value={wholesalerPasswordInput}
                onChange={(e) => setWholesalerPasswordInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && confirmWholesalerLock()}
                className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                placeholder="পাসওয়ার্ড লিখুন"
                autoFocus
              />

              {wholesalerPasswordError && <p className="text-sm text-red-600 mt-3">{wholesalerPasswordError}</p>}

              <button
                onClick={confirmWholesalerLock}
                className="w-full mt-5 bg-violet-700 text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-violet-800"
              >
                <Lock size={18} /> প্রবেশ করুন
              </button>
            </div>
          </div>
        )}

        {/* ইউজার ম্যানেজমেন্ট (শুধু এডমিনের জন্য) */}
        {showUserManagement && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">
                  {editingUserId ? 'ইউজার এডিট করুন' : 'নতুন এডমিন/মডারেটর যোগ করুন'}
                </h2>
                <button onClick={() => { setShowUserManagement(false); cancelEditUser(); }} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>

              <form onSubmit={handleAddUser} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500">নাম *</label>
                  <input
                    type="text"
                    value={userForm.name}
                    onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: করিম"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500">ফোন নাম্বার *</label>
                  <input
                    type="text"
                    value={userForm.phone}
                    onChange={(e) => setUserForm({ ...userForm, phone: e.target.value })}
                    className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                    placeholder="যেমন: ০১৭xxxxxxxx"
                  />
                </div>
                {!editingUserId && (
                  <div>
                    <label className="text-xs font-semibold text-gray-500">পাসওয়ার্ড *</label>
                    <input
                      type="text"
                      value={userForm.password}
                      onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                      className="w-full mt-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#034B58]"
                      placeholder="পাসওয়ার্ড লিখুন"
                    />
                  </div>
                )}
                <div>
                  <label className="text-xs font-semibold text-gray-500">ধরন</label>
                  <div className="flex gap-3 mt-1">
                    <button
                      type="button"
                      onClick={() => setUserForm({ ...userForm, role: 'moderator' })}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border ${userForm.role === 'moderator' ? 'bg-[#075B68] text-white border-[#075B68]' : 'border-gray-200 text-gray-600'}`}
                    >
                      মডারেটর
                    </button>
                    <button
                      type="button"
                      onClick={() => setUserForm({ ...userForm, role: 'admin' })}
                      className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border ${userForm.role === 'admin' ? 'bg-[#075B68] text-white border-[#075B68]' : 'border-gray-200 text-gray-600'}`}
                    >
                      এডমিন
                    </button>
                  </div>
                </div>

                <label className="flex items-start gap-2.5 bg-rose-50 rounded-xl p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={userForm.is_partner}
                    onChange={(e) => setUserForm({ ...userForm, is_partner: e.target.checked })}
                    className="mt-0.5"
                  />
                  <span className="text-xs text-gray-700">
                    ✅ পার্টনার যোগ করুন — টিক দিলে এই ইউজার "পার্টনার হিসাব"-এও যুক্ত হয়ে যাবে
                  </span>
                </label>

                {userError && <p className="text-sm text-red-600">{userError}</p>}

                <button
                  type="submit"
                  disabled={userSubmitting}
                  className="w-full bg-[#075B68] text-white rounded-full py-3 flex items-center justify-center gap-2 font-semibold text-sm active:bg-[#034B58] disabled:opacity-60"
                >
                  {userSubmitting ? <Loader2 size={18} className="animate-spin" /> : <UserPlus size={18} />}
                  {userSubmitting ? 'সেভ হচ্ছে...' : editingUserId ? 'আপডেট করুন' : 'যোগ করুন'}
                </button>
                {editingUserId && (
                  <button type="button" onClick={cancelEditUser} className="w-full text-center text-sm text-gray-500 py-1">
                    বাতিল করুন
                  </button>
                )}
              </form>

              {users.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-sm font-bold text-gray-900 mb-3">সব ইউজার</h3>
                  <div className="flex flex-col gap-3">
                    {users.map((u) => (
                      <div
                        key={u.id}
                        className={`bg-white rounded-2xl shadow-md p-4 flex items-center gap-3 border-l-4 ${u.role === 'admin' ? 'border-[#034B58]' : 'border-amber-500'}`}
                      >
                        {u.photo_url ? (
                          <img src={u.photo_url} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center font-bold text-sm shrink-0">
                            {u.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-gray-900 text-sm">{u.name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {u.phone} · {u.role}{u.is_partner ? ' · পার্টনার' : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {u.is_partner ? (
                            <div className="flex items-center gap-1 text-gray-400" title="পার্টনার একাউন্ট — এডিট/ডিলিট সুরক্ষিত">
                              <Lock size={15} />
                            </div>
                          ) : (
                            <>
                              <button
                                onClick={() => startEditUser(u)}
                                className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center"
                              >
                                <Pencil size={15} className="text-amber-700" />
                              </button>
                              {u.phone !== '01775515571' && (
                                <button
                                  onClick={() => deleteUser(u.id)}
                                  className="w-9 h-9 rounded-full bg-red-100 flex items-center justify-center"
                                >
                                  <Trash2 size={15} className="text-red-700" />
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* নোটিফিকেশন */}
        {showNotifications && (
          <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50">
            <div className="w-full sm:max-w-sm bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-900">নোটিফিকেশন</h2>
                <button onClick={() => setShowNotifications(false)} className="text-gray-400">
                  <X size={22} />
                </button>
              </div>
              {notifications.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">এখনো কোনো নোটিফিকেশন নেই</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {notifications.map((n) =>
                    n.type === 'edit_approval' && n.edit_request && n.edit_request.status === 'pending' ? (
                      <div key={n.id} className="bg-white rounded-2xl shadow-md border-2 border-amber-300 p-4">
                        <p className="text-sm font-semibold text-gray-900">{n.message}</p>
                        <p className="text-xs text-gray-400 mt-1 mb-3">{new Date(n.created_at).toLocaleString('bn-BD')}</p>

                        <div className="bg-red-50 rounded-xl p-3 mb-2">
                          <p className="text-[10px] font-bold text-red-700 uppercase mb-1">আগে যা ছিল</p>
                          <p className="text-sm text-gray-800">{n.edit_request.old_description}</p>
                          <p className="text-sm font-bold text-gray-900 mt-0.5">৳{n.edit_request.old_amount}</p>
                        </div>
                        <div className="bg-emerald-50 rounded-xl p-3 mb-3">
                          <p className="text-[10px] font-bold text-emerald-700 uppercase mb-1">নতুন যা হবে</p>
                          <p className="text-sm text-gray-800">{n.edit_request.new_description}</p>
                          <p className="text-sm font-bold text-gray-900 mt-0.5">৳{n.edit_request.new_amount}</p>
                        </div>

                        <div className="flex gap-3">
                          <button
                            onClick={() => respondToEditRequest(n.edit_request.id, n.id, 'reject')}
                            className="flex-1 bg-red-100 text-red-700 rounded-full py-2.5 text-sm font-semibold active:bg-red-200"
                          >
                            ❌ রিজেক্ট
                          </button>
                          <button
                            onClick={() => respondToEditRequest(n.edit_request.id, n.id, 'approve')}
                            className="flex-1 bg-emerald-600 text-white rounded-full py-2.5 text-sm font-semibold active:bg-emerald-700"
                          >
                            ✅ এপ্রুভ
                          </button>
                        </div>
                      </div>
                    ) : n.type === 'edit_approval' && n.edit_request ? (
                      // এডিট রিকোয়েস্টের ফলাফল — এপ্রুভ/রিজেক্ট হয়ে গেছে, শুধু দেখার জন্য
                      <div
                        key={n.id}
                        className={`bg-white rounded-2xl shadow-sm border-2 p-4 ${
                          n.edit_request.status === 'approved' ? 'border-emerald-200' : 'border-red-200'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-gray-900">{n.message}</p>
                          <button
                            onClick={() => markNotificationRead(n.id)}
                            className="text-xs font-semibold text-[#034B58] bg-red-50 rounded-full px-3 py-1.5 shrink-0"
                          >
                            রিড
                          </button>
                        </div>
                        <p className="text-xs text-gray-400 mt-1 mb-3">{new Date(n.created_at).toLocaleString('bn-BD')}</p>

                        <div className="bg-gray-50 rounded-xl p-3 mb-2">
                          <p className="text-[10px] font-bold text-gray-500 uppercase mb-1">আগে যা ছিল</p>
                          <p className="text-sm text-gray-800">{n.edit_request.old_description}</p>
                          <p className="text-sm font-bold text-gray-900 mt-0.5">৳{n.edit_request.old_amount}</p>
                        </div>
                        <div className={`rounded-xl p-3 ${n.edit_request.status === 'approved' ? 'bg-emerald-50' : 'bg-red-50'}`}>
                          <p className={`text-[10px] font-bold uppercase mb-1 ${n.edit_request.status === 'approved' ? 'text-emerald-700' : 'text-red-700'}`}>
                            {n.edit_request.status === 'approved' ? 'যা করতে চেয়েছিলেন (এপ্রুভ হয়েছে)' : 'যা করতে চেয়েছিলেন (রিজেক্ট হয়েছে)'}
                          </p>
                          <p className="text-sm text-gray-800">{n.edit_request.new_description}</p>
                          <p className="text-sm font-bold text-gray-900 mt-0.5">৳{n.edit_request.new_amount}</p>
                        </div>
                      </div>
                    ) : n.type === 'order_edit_approval' && n.order_edit_request ? (
                      <div key={n.id} className="bg-white rounded-2xl shadow-md border-2 border-amber-300 p-4">
                        <p className="text-sm font-semibold text-gray-900">{n.message}</p>
                        <p className="text-xs text-gray-400 mt-1 mb-3">{new Date(n.created_at).toLocaleString('bn-BD')}</p>

                        <div className="bg-red-50 rounded-xl p-3 mb-2">
                          <p className="text-[10px] font-bold text-red-700 uppercase mb-1">আগে যা ছিল</p>
                          <p className="text-sm text-gray-800 whitespace-pre-wrap">{n.order_edit_request.original_raw_text}</p>
                        </div>
                        <div className="bg-emerald-50 rounded-xl p-3 mb-3">
                          <p className="text-[10px] font-bold text-emerald-700 uppercase mb-1">নতুন যা হবে</p>
                          <p className="text-sm text-gray-800 whitespace-pre-wrap">{n.order_edit_request.proposed_raw_text}</p>
                        </div>

                        <div className="flex gap-3">
                          <button
                            onClick={() => respondToOrderEditRequest(n.order_edit_request.id, n.id, 'decline')}
                            className="flex-1 bg-red-100 text-red-700 rounded-full py-2.5 text-sm font-semibold active:bg-red-200"
                          >
                            ❌ রিজেক্ট
                          </button>
                          <button
                            onClick={() => respondToOrderEditRequest(n.order_edit_request.id, n.id, 'approve')}
                            className="flex-1 bg-emerald-600 text-white rounded-full py-2.5 text-sm font-semibold active:bg-emerald-700"
                          >
                            ✅ এপ্রুভ
                          </button>
                        </div>
                      </div>
                    ) : n.type === 'order_delete_approval' && n.order_delete_request ? (
                      <div key={n.id} className="bg-white rounded-2xl shadow-md border-2 border-amber-300 p-4">
                        <p className="text-sm font-semibold text-gray-900">{n.message}</p>
                        <p className="text-xs text-gray-400 mt-1 mb-3">{new Date(n.created_at).toLocaleString('bn-BD')}</p>

                        <div className="bg-red-50 rounded-xl p-3 mb-3">
                          <p className="text-[10px] font-bold text-red-700 uppercase mb-1">যে পোস্টটা মুছতে চাচ্ছেন</p>
                          <p className="text-sm text-gray-800 whitespace-pre-wrap">{n.order_delete_request.raw_text}</p>
                        </div>

                        {n.order_delete_request.reason && (
                          <div className="bg-amber-50 rounded-xl p-3 mb-3">
                            <p className="text-[10px] font-bold text-amber-700 uppercase mb-1">কারণ</p>
                            <p className="text-sm text-gray-800 whitespace-pre-wrap">{n.order_delete_request.reason}</p>
                          </div>
                        )}

                        <div className="flex gap-3">
                          <button
                            onClick={() => respondToOrderDeleteRequest(n.order_delete_request.id, n.id, 'decline')}
                            className="flex-1 bg-red-100 text-red-700 rounded-full py-2.5 text-sm font-semibold active:bg-red-200"
                          >
                            ❌ রিজেক্ট
                          </button>
                          <button
                            onClick={() => respondToOrderDeleteRequest(n.order_delete_request.id, n.id, 'approve')}
                            className="flex-1 bg-emerald-600 text-white rounded-full py-2.5 text-sm font-semibold active:bg-emerald-700"
                          >
                            ✅ এপ্রুভ
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div key={n.id} className="bg-white rounded-2xl shadow-sm border border-gray-200 p-3.5 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm text-gray-800">{n.message}</p>
                          <p className="text-xs text-gray-400 mt-1">{new Date(n.created_at).toLocaleString('bn-BD')}</p>
                        </div>
                        <button
                          onClick={() => markNotificationRead(n.id)}
                          className="text-xs font-semibold text-[#034B58] bg-red-50 rounded-full px-3 py-1.5 shrink-0"
                        >
                          রিড
                        </button>
                      </div>
                    )
                  )}
                </div>
              )}

              {/* নোটিফিকেশন হিস্ট্রি */}
              <div className="mt-6 border-t border-gray-200 pt-4">
                <button
                  onClick={toggleNotificationHistory}
                  className="w-full flex items-center justify-between bg-gray-50 rounded-2xl px-4 py-3"
                >
                  <span className="text-sm font-semibold text-gray-700">নোটিফিকেশন হিস্ট্রি (৩০ দিন)</span>
                  <ChevronRight size={16} className={`text-gray-400 transition-transform ${showNotificationHistory ? 'rotate-90' : ''}`} />
                </button>

                {showNotificationHistory && (
                  <div className="mt-3">
                    {historyLoading ? (
                      <div className="flex justify-center py-6">
                        <Loader2 size={22} className="animate-spin text-[#034B58]" />
                      </div>
                    ) : notificationHistory.length === 0 ? (
                      <p className="text-xs text-gray-400 text-center py-4">হিস্ট্রিতে কিছু নেই</p>
                    ) : (
                      <div className="flex flex-col gap-2.5">
                        {notificationHistory.map((n) => (
                          <div key={n.id} className="bg-gray-50 rounded-2xl p-3.5 opacity-80">
                            <p className="text-sm text-gray-700">{n.message}</p>
                            <p className="text-xs text-gray-400 mt-1">
                              রিড করা হয়েছে: {new Date(n.read_at).toLocaleString('bn-BD')}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('maya_token');
    const userStr = localStorage.getItem('maya_user');
    if (token && userStr) {
      try {
        setCurrentUser(JSON.parse(userStr));
      } catch (err) {
        localStorage.removeItem('maya_token');
        localStorage.removeItem('maya_user');
      }
    }
    setAuthChecked(true);
  }, []);

  const handleLoggedIn = (user) => {
    setCurrentUser(user);
  };

  const handleLogout = () => {
    localStorage.removeItem('maya_token');
    localStorage.removeItem('maya_user');
    setCurrentUser(null);
  };

  const handleUpdateUser = (updatedFields) => {
    setCurrentUser((prev) => {
      const merged = { ...prev, ...updatedFields };
      localStorage.setItem('maya_user', JSON.stringify(merged));
      return merged;
    });
  };

  if (!authChecked) return null;

  if (!currentUser) {
    return <LoginScreen onLoggedIn={handleLoggedIn} />;
  }

  if (currentUser.role === 'employee') {
    return <EmployeeView currentUser={currentUser} onLogout={handleLogout} />;
  }

  return <Dashboard currentUser={currentUser} onLogout={handleLogout} onUpdateUser={handleUpdateUser} />;
}
