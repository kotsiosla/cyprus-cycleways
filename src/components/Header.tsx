import { Button } from '@/components/ui/button';
import { BatteryCharging, Menu, X, Download, Moon, Sun } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useTheme } from 'next-themes';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const Header = () => {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    setMounted(true);
  }, []);

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  };

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setIsInstallable(true);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === 'accepted') {
      setIsInstallable(false);
    }
    setDeferredPrompt(null);
  };

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        isScrolled ? 'glass py-3' : 'bg-transparent py-4'
      }`}
    >
      <div className="container flex items-center justify-between">
        <a href="/" className="flex items-center gap-2 group">
          <div className="p-2 rounded-xl bg-primary text-primary-foreground group-hover:shadow-glow transition-shadow">
            <BatteryCharging className="w-5 h-5" />
          </div>
          <span className="font-display font-bold text-lg">ChargeCyprus</span>
        </a>

        <nav className="hidden md:flex items-center gap-6">
          <a href="#map" className="text-sm font-medium hover:text-primary transition-colors">
            Map
          </a>
          <a href="#route" className="text-sm font-medium hover:text-primary transition-colors">
            Route
          </a>
          <a href="#stations" className="text-sm font-medium hover:text-primary transition-colors">
            Stations
          </a>
          <a href="#about" className="text-sm font-medium hover:text-primary transition-colors">
            About
          </a>
        </nav>

        <div className="flex items-center gap-2">
          {isInstallable && (
            <Button variant="hero" size="sm" onClick={handleInstall}>
              <Download className="w-4 h-4" />
              Install App
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={toggleTheme}
            aria-label="Toggle theme"
            title={mounted && resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="gap-2"
          >
            {mounted && resolvedTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            <span className="hidden sm:inline">
              {mounted && resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}
            </span>
          </Button>
          <button
            className="md:hidden p-2 hover:bg-muted rounded-lg transition-colors"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            aria-label="Toggle menu"
          >
            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {isMobileMenuOpen && (
        <div className="md:hidden glass mt-2 mx-4 p-4 rounded-xl animate-slide-up">
          <nav className="flex flex-col gap-3">
            <a href="#map" className="text-sm font-medium hover:text-primary transition-colors py-2">
              Map
            </a>
            <a href="#route" className="text-sm font-medium hover:text-primary transition-colors py-2">
              Route
            </a>
            <a href="#stations" className="text-sm font-medium hover:text-primary transition-colors py-2">
              Stations
            </a>
            <a href="#about" className="text-sm font-medium hover:text-primary transition-colors py-2">
              About
            </a>
            {isInstallable && (
              <Button variant="hero" size="sm" onClick={handleInstall} className="mt-2">
                <Download className="w-4 h-4" />
                Install App
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={toggleTheme}
              className="gap-2"
            >
              {mounted && resolvedTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              {mounted && resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'}
            </Button>
          </nav>
        </div>
      )}
    </header>
  );
};

export default Header;
