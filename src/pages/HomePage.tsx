import { Link } from 'react-router-dom'
import { LessonsIcon, PracticeIcon, ProgressIcon, QuranIcon } from '../components/NavIcons'

const FEATURES = [
  {
    to: '/lessons',
    title: 'أحكام التجويد',
    desc: 'دروس مبسطة لكل أحكام النون الساكنة والتنوين، الميم الساكنة، الإدغام المتجانس والمتقارب، المدود، القلقلة، والغنة — مع أمثلة قرآنية ملونة حيّة واختبارات قصيرة.',
    Icon: LessonsIcon,
  },
  {
    to: '/quran',
    title: 'المصحف الملوّن',
    desc: 'تصفح القرآن الكريم كاملًا بالتشكيل، مع تلوين كل حكم تجويدي تلقائيًا وفق مصحف التجويد، ومعاني الألوان، واستماع لتلاوة الشيخ العفاسي.',
    Icon: QuranIcon,
  },
  {
    to: '/practice',
    title: 'صحّح تلاوتك بالذكاء الاصطناعي',
    desc: 'سجّل تلاوتك وسيقوم نموذج تعرّف صوتي متقدم (Whisper) يعمل داخل متصفحك بمقارنتها بالنص الصحيح، وتمييز الكلمات الخاطئة أو الناقصة فورًا.',
    Icon: PracticeIcon,
  },
  {
    to: '/progress',
    title: 'تتبّع تقدّمك',
    desc: 'سجلٌّ لكل محاولات التلاوة ونسب الدقة، والدروس المكتملة، وأيام المواظبة المتتالية.',
    Icon: ProgressIcon,
  },
]

export function HomePage() {
  return (
    <div className="space-y-12">
      <section
        className="pattern-panel card-lux relative rounded-[2rem]! px-6 py-14 text-center sm:px-12"
        style={{
          background:
            'linear-gradient(160deg, color-mix(in srgb, var(--c-accent) 16%, var(--c-surface)) 0%, var(--c-surface) 45%, color-mix(in srgb, var(--c-gold) 12%, var(--c-surface)) 100%)',
        }}
      >
        <div className="relative">
          <p className="mb-4 flex items-center justify-center gap-3 text-sm font-bold tracking-wide text-gold">
            <span className="hair-gold w-10" aria-hidden />
            تعلّم <span aria-hidden>◆</span> رتّل <span aria-hidden>◆</span> صحّح
            <span className="hair-gold w-10" aria-hidden />
          </p>
          <h1 className="text-gilded font-display text-4xl leading-[1.6] sm:text-5xl">تعلّم التجويد وصحّح تلاوتك</h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted">
            منصة تفاعلية فاخرة لتعلّم أحكام التجويد والتشكيل الصحيح، مع تصحيح فوري لتلاوتك عبر ذكاء اصطناعي يعمل بالكامل
            داخل متصفحك دون رفع صوتك لأي خادم.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/practice" className="btn-gold">
              ابدأ التلاوة الآن
            </Link>
            <Link to="/lessons" className="btn-ghost">
              استكشف الدروس
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-5 sm:grid-cols-2">
        {FEATURES.map(({ to, title, desc, Icon }) => (
          <Link key={to} to={to} className="card-lux card-hover group relative p-6 sm:p-7">
            <span
              aria-hidden
              className="absolute inset-x-6 top-0 h-px bg-gradient-to-l from-transparent via-gold/60 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            />
            <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-gold/40 bg-accent-soft text-accent shadow-sm transition group-hover:border-gold group-hover:text-gold">
              <Icon className="h-6 w-6" />
            </span>
            <h2 className="mb-2 font-display text-xl font-bold text-ink transition-colors group-hover:text-accent">{title}</h2>
            <p className="text-sm leading-relaxed text-muted">{desc}</p>
          </Link>
        ))}
      </section>

      <section className="card-lux px-6 py-8 text-center">
        <p className="font-quran text-2xl leading-loose text-ink sm:text-3xl">
          وَرَتِّلِ الْقُرْآنَ تَرْتِيلًا
        </p>
        <p className="mt-2 text-xs font-medium tracking-wide text-faint">سورة المزّمّل — الآية ٤</p>
      </section>
    </div>
  )
}
