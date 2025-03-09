export class NotificationManager {
  static show(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('show');
    }, 10);

    setTimeout(() => {
      notification.classList.remove('show');
      setTimeout(() => document.body.removeChild(notification), 500);
    }, 3000);
  }
}

export class BookmarksManager {
  constructor() {
    this.apiBase = 'https://ca691c15a010b4d51f69.free.beeceptor.com/api/bookmarks/';
  }

  async addBookmark(city, province) {
    try {
      const response = await fetch(this.apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, province })
      });
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('Batas permintaan API tercapai. Coba lagi nanti.');
        }
        throw new Error('Gagal menambahkan bookmark.');
      }
      return await response.json();
    } catch (error) {
      console.error('Add Bookmark Error:', error);
      throw error;
    }
  }

  async getBookmarks() {
    try {
      const response = await fetch(this.apiBase);
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('Batas permintaan API tercapai. Coba lagi nanti.');
        }
        throw new Error('Gagal mengambil daftar bookmark.');
      }
      return await response.json();
    } catch (error) {
      console.error('Get Bookmarks Error:', error);
      throw error;
    }
  }

  async deleteBookmark(id) {
    try {
      const response = await fetch(`${this.apiBase}${id}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('Batas permintaan API tercapai. Coba lagi nanti.');
        }
        throw new Error('Gagal menghapus bookmark.');
      }
      return true;
    } catch (error) {
      console.error('Delete Bookmark Error:', error);
      throw error;
    }
  }
}