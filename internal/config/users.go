package config

import (
	"errors"
	"fmt"
	"slices"
	"strings"
)

// Team credentials and grants stay in the private configuration file.
type User struct {
	ID           string       `json:"id"`
	Username     string       `json:"username"`
	PasswordHash string       `json:"passwordHash"`
	Disabled     bool         `json:"disabled,omitempty"`
	Projects     []ProjectRef `json:"projects"`
	OpenProjects []ProjectRef `json:"openProjects"`
}

func (c Config) ModeName() string {
	if c.Mode == "" {
		return "personal"
	}
	return c.Mode
}

func (c Config) User(id string) (User, bool) {
	for _, user := range c.Users {
		if user.ID == id {
			return user, true
		}
	}
	return User{}, false
}

func (c Config) UserCanRead(id string, project ProjectRef) bool {
	user, ok := c.User(id)
	return ok && !user.Disabled && slices.Contains(user.Projects, project) && c.ProjectVisible(project)
}

func (c Config) ProjectExists(project ProjectRef) bool {
	for _, host := range c.Hosts {
		if host.ID == project.Host {
			for _, root := range host.Roots {
				if root.ID == project.Root {
					return true
				}
			}
		}
	}
	return false
}

func validateUsers(c Config) error {
	if c.ModeName() != "personal" && c.ModeName() != "team" {
		return errors.New("mode must be personal or team")
	}
	if len(c.Users) > 128 {
		return errors.New("at most 128 users are supported")
	}
	ids, names := map[string]bool{}, map[string]bool{}
	for _, user := range c.Users {
		if !safeID(user.ID) || ids[user.ID] {
			return errors.New("users must have unique, valid identifiers")
		}
		if !safeID(user.Username) || user.Username != strings.ToLower(user.Username) || names[user.Username] {
			return errors.New("usernames must be unique lowercase identifiers using letters, numbers, underscores or hyphens")
		}
		ids[user.ID], names[user.Username] = true, true
		if _, err := parseHash(user.PasswordHash); err != nil {
			return errors.New("invalid user password hash")
		}
		for _, refs := range [][]ProjectRef{user.Projects, user.OpenProjects} {
			if err := validateOpenProjects(refs); err != nil {
				return fmt.Errorf("user projects: %w", err)
			}
		}
		for _, ref := range user.Projects {
			if !c.ProjectExists(ref) {
				return errors.New("user access refers to an unknown project")
			}
		}
	}
	return nil
}

func (c *Config) pruneUserProjects() {
	c.Users = slices.Clone(c.Users)
	for i, user := range c.Users {
		projects := make([]ProjectRef, 0, len(user.Projects))
		for _, ref := range user.Projects {
			if c.ProjectExists(ref) {
				projects = append(projects, ref)
			}
		}
		c.Users[i].Projects = projects
		opened := make([]ProjectRef, 0, len(user.OpenProjects))
		for _, ref := range user.OpenProjects {
			if c.UserCanRead(user.ID, ref) {
				opened = append(opened, ref)
			}
		}
		c.Users[i].OpenProjects = opened
	}
}
