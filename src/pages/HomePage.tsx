import { Link } from 'react-router-dom'

const FEATURES = [
  {
    to: '/lessons',
    title: 'أحكام التجويد',
    desc: 'دروس مبسطة لكل أحكام النون الساكنة والتنوين، الميم الساكنة، المدود، القلقلة، والغنة — مع أمثلة قرآنية ملونة حيّة واختبارات قصيرة.',
    icon: '📖',
  },
  {
    to: '/quran',
    title: 'المصحف الملوّن',
    desc: 'تصفح القرآن الكريم كاملاً بالتشكيل، مع تلوين كل حكم تجويدي تلقائيًا، ومعاني الألوان، واستماع لتلاوة الشيخ العفاسي.',
    icon: '🎨',
  },
  {
    to: '/practice',
    title: 'صحّح تلاوتك بالذكاء الاصطناعي',
    desc: 'سجّل تلاوتك وسيقوم نموذج تعرّف صوتي متقدم (Whisper) يعمل داخل متصفحك بمقارنتها بالنص الصحيح، وتمييز الكلمات الخاطئة أو الناقصة فورًا.',
    icon: '🎙️',
  },
  {
    to: '/progress',
    title: 'تتبّع تقدّمك',
    desc: 'سجل لكل محاولات التلاوة ونسب الدقة، والدروس المكتملة، وأيام المواظبة المتتالية.',
    icon: '📈',
  },
]

export function HomePage() {
  return (
    <div className="space-y-10">
      <section className="rounded-3xl bg-gradient-to-l from-brand-700 to-emerald-950 px-6 py-12 text-center text-white shadow-xl">
        <p className="mb-3 text-sm font-semibold tracking-wide text-brand-200">تعلّم • رتّل • صحّح</p>
        <h1 className="font-quran text-4xl leading-relaxed sm:text-5xl">تعلّم التجويد وصحّح تلاوتك</h1>
        <p className="mx-auto mt-4 max-w-2xl text-brand-50/90">
          منصة تفاعلية لتعلّم أحكام التجويد والتشكيل الصحيح، مع تصحيح فوري لتلاوتك عبر ذكاء اصطناعي يعمل بالكامل
          داخل متصفحك دون رفع صوتك لأي خادم.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            to="/practice"
            className="rounded-full bg-gold-400 px-6 py-2.5 font-bold text-emerald-950 shadow transition hover:bg-gold-500"
          >
            ابدأ التلاوة الآن
          </Link>
          <Link
            to="/lessons"
            className="rounded-full border border-white/40 px-6 py-2.5 font-bold text-white transition hover:bg-white/10"
          >
            استكشف الدروس
          </Link>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <Link
            key={f.to}
            to={f.to}
            className="group rounded-2xl border border-brand-200/70 bg-white/70 p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-brand-900/50 dark:bg-white/5"
          >
            <div className="mb-3 text-3xl">{f.icon}</div>
            <h2 className="mb-1.5 text-lg font-bold text-emerald-900 group-hover:text-brand-700 dark:text-brand-50">
              {f.title}
            </h2>
            <p className="text-sm leading-relaxed text-emerald-900/70 dark:text-brand-100/70">{f.desc}</p>
          </Link>
        ))}
      </section>
    </div>
  )
}
